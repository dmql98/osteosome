/**
 * loop 服务入口（P3 WS-3）—— 装配：loop.run → 先落 user 消息 → 发 llm.request → 流式回填 → message.append。
 *
 * - **唯一写者**：assistant 消息只经 loop（in-flight 累积、finish 时 append）；user 消息先落库再发 llm.request。
 * - **requestId 分层**：A = loop.run（前端只见 A），B = llm.request 内部 id；映射只活在 loop 进程。
 * - **只吃总线**：不直读 session 文件，经 `session.*` 命令 + `*.result` 拿历史（服务间唯一通道 = 总线）。
 * - **参数透传**（P4 WS-2）：`loop.run` 的 `provider` / `model` / `thinking` 一路带进 `llm.request`。
 */
import { Service } from '@osteosome/service-sdk'
import { normalizeThinking, type ThinkingEffort } from '@osteosome/shared'
import { randomUUID } from 'node:crypto'
import { LoopCore } from './core'
import { buildMessages, DEFAULT_MAX_MESSAGES } from './history'
import { DEFAULT_SYSTEM_PROMPT } from './prompt'
import type { HistoryMessage } from './history'

const service = new Service({ id: 'loop', version: '1.0.0' })

/** A → { sessionId }（loop.run 时记，finish/fail 后发 state.changed 用） */
const sessionsByA = new Map<string, string>()
/** historyReq（session.get 命令 id）→ A（关联多轮历史拉取往返） */
const historyReqByRun = new Map<string, string>()

/**
 * 目标 provider（P4 WS-2：`loop.run` 可逐次指定；缺省回落 env → deepseek）。
 * 测试与冒烟经 LLM_PROVIDER 指向本地假上游（openai 位）。
 */
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER?.trim() || 'deepseek'

/**
 * 本次 run 的请求参数（P4 WS-2）。
 *
 * loop 同时只跑一轮（`core.isBusy()` 重入守卫），所以装配层用模块级「当前 run 参数」即可，
 * 不必把参数穿进 LoopCore 状态机（LoopCore 只认 model —— 它 P3 就有 `start(b, msgs, model?)` 形参）。
 * accept 时写，start（拿到历史后）时读。
 */
let currentParams: { provider?: string; model?: string; thinking?: ThinkingEffort } = {}

const core = new LoopCore({
  sendLlmRequest(b, sessionId, messages, model) {
    service.publish('llm.request', {
      requestId: b,
      provider: currentParams.provider ?? DEFAULT_PROVIDER,
      messages,
      ...(model ? { model } : {}),
      ...(currentParams.thinking ? { thinking: currentParams.thinking } : {}),
    })
  },
  sendLlmCancel(b) {
    service.publish('llm.cancel', { requestId: b })
  },
})

function newB(): string {
  return `loop-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

service.subscribe('loop.run', (payload) => {
  const a = typeof payload.requestId === 'string' ? payload.requestId : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  // P4 WS-2：本次 run 的 provider / model / thinking（非法 thinking 静默丢弃 = 用模型默认）
  const runParams = {
    ...(typeof payload.provider === 'string' && payload.provider ? { provider: payload.provider } : {}),
    ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
    ...(normalizeThinking(payload.thinking) ? { thinking: normalizeThinking(payload.thinking) as ThinkingEffort } : {}),
  }

  const fail = (code: string, message: string) => {
    service.publish('loop.run.failed', { requestId: a, sessionId, error: { code, message } })
    service.publish('loop.state.changed', { requestId: a, sessionId, state: 'idle' })
  }

  if (!a || !sessionId || !text) {
    fail('invalid_request', 'loop.run: requestId, sessionId and text are required')
    return
  }
  // 重入拒绝（P3 §6：running 中重复 run → busy）
  if (core.isBusy()) {
    fail('busy', 'loop is running')
    return
  }

  // 1) 先落 user 消息（不等 llm 响应，会话里立即可见）
  service.publish('message.append', { requestId: `mu-${a}`, sessionId, message: { role: 'user', content: text } })

  // 2) 受理 run（占位防重入）→ 发 session.get 拉历史；拿到 result 后才 start(B) 发 llm.request（多轮）
  const historyReq = `hg-${a}`
  historyReqByRun.set(historyReq, a)
  if (!core.accept(a, sessionId, text)) {
    fail('busy', 'loop is running')
    return
  }
  currentParams = runParams
  sessionsByA.set(a, sessionId)
  service.publish('session.get', { requestId: historyReq, sessionId })

  // 3) state running（已受理，模型在途）
  service.publish('loop.state.changed', { requestId: a, sessionId, state: 'running' })
})

// session.get.result（关联 historyReq）→ 拼多轮 → core.start(B) → 发 llm.request
service.subscribe('session.get.result', (payload) => {
  const p = payload as { requestId?: string; session?: { messages?: unknown[] } | null; error?: { code?: string; message?: string } }
  const a = p?.requestId ? historyReqByRun.get(p.requestId) : undefined
  if (!a) return // 非本次历史拉取（或已释放/已取消）
  historyReqByRun.delete(p.requestId!)

  // 兜底1：session.get 报错（会话不存在等）→ 用本轮 text 跑一问一答，不卡在 running
  if (p?.error) {
    const messages = buildMessages([{ role: 'user', content: core.awaitingRun()?.text ?? '' }], DEFAULT_SYSTEM_PROMPT, DEFAULT_MAX_MESSAGES)
    core.start(newB(), messages, currentParams.model)
    return
  }

  // 兜底2：session 为 null（会话已被删）→ 同样用本轮 text 跑一问一答
  // 正常路径：历史已含 loop.run 先落库的 user 消息（末尾），buildMessages 直接用完整历史
  const history = (p?.session?.messages ?? []) as HistoryMessage[]
  const messages = buildMessages(history, DEFAULT_SYSTEM_PROMPT, DEFAULT_MAX_MESSAGES)

  core.start(newB(), messages, currentParams.model)
})

// llm.token.streamed（B）→ 累积 + 换发 A（P3 §3.4：B 不泄前端）
service.subscribe('llm.token.streamed', (payload) => {
  const b = typeof payload.requestId === 'string' ? payload.requestId : ''
  const token = typeof payload.token === 'string' ? payload.token : ''
  const index = typeof payload.index === 'number' ? payload.index : 0
  const a = core.onToken(b, token)
  if (!a) return
  const sessionId = sessionsByA.get(a) ?? ''
  // 换发：requestId 换成 A，index 保留 llm 原值（P3 §3.4）
  service.publish('loop.token.streamed', { requestId: a, sessionId, token, index })
})

// llm.request.finished（B）→ 取 A + 累积全文 → message.append(assistant) → state idle
service.subscribe('llm.request.finished', (payload) => {
  const b = typeof payload.requestId === 'string' ? payload.requestId : ''
  const finishReason = typeof payload.finishReason === 'string' ? payload.finishReason : 'stop'
  const usage = payload.usage as { promptTokens: number; completionTokens: number } | undefined
  const done = core.finish(b, finishReason, usage)
  if (!done) return
  const sessionId = sessionsByA.get(done.a) ?? done.sessionId
  // 落 assistant 全文（finishReason/usage 带上）
  service.publish('message.append', {
    requestId: `ma-${done.a}`,
    sessionId,
    message: {
      role: 'assistant',
      content: done.content,
      finishReason: done.finishReason,
      ...(done.usage ? { usage: done.usage } : {}),
    },
  })
  service.publish('loop.state.changed', { requestId: done.a, sessionId, state: 'idle' })
  sessionsByA.delete(done.a)
})

// llm.request.failed（B）→ loop.run.failed(A) + state idle，不落 assistant
service.subscribe('llm.request.failed', (payload) => {
  const b = typeof payload.requestId === 'string' ? payload.requestId : ''
  const error = payload.error as { code?: string; message?: string } | undefined
  const failed = core.fail(b)
  if (!failed) return
  const sessionId = sessionsByA.get(failed.a) ?? failed.sessionId
  service.publish('loop.run.failed', {
    requestId: failed.a,
    sessionId,
    error: { code: error?.code ?? 'unknown', message: error?.message ?? 'llm failed' },
  })
  service.publish('loop.state.changed', { requestId: failed.a, sessionId, state: 'idle' })
  sessionsByA.delete(failed.a)
})

// loop.cancel（A）→ 在途：llm.cancel(B)（等 finish{stop} 收尾）；awaiting：直接清占位发 run.cancelled
service.subscribe('loop.cancel', (payload) => {
  const a = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!a) return
  // awaiting 阶段（等 session.get 还没发 llm.request）：直接收尾
  const cancelledEarly = core.cancelAwaiting(a)
  if (cancelledEarly) {
    const sessionId = sessionsByA.get(a) ?? cancelledEarly.sessionId
    service.publish('loop.run.cancelled', { requestId: a, sessionId })
    service.publish('loop.state.changed', { requestId: a, sessionId, state: 'idle' })
    sessionsByA.delete(a)
    return
  }
  core.cancel(a) // 未知 A → 静默忽略；在途则发 llm.cancel(B)
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`loop: failed to start: ${String(err)}`)
  process.exit(1)
})
