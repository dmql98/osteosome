/**
 * loop 服务入口（P3 WS-3）—— 装配：loop.run → 先落 user 消息 → 发 llm.request → 流式回填 → message.append。
 *
 * - **唯一写者**：assistant 消息只经 loop（in-flight 累积、finish 时 append）；user 消息先落库再发 llm.request。
 * - **requestId 分层**：A = loop.run（前端只见 A），B = llm.request 内部 id；映射只活在 loop 进程。
 * - **只吃总线**：不直读 session 文件，经 `session.*` 命令 + `*.result` 拿历史（服务间唯一通道 = 总线）。
 */
import { Service } from '@osteosome/service-sdk'
import { randomUUID } from 'node:crypto'
import { LoopCore } from './core'
import { buildMessages, DEFAULT_MAX_MESSAGES } from './history'
import { DEFAULT_SYSTEM_PROMPT } from './prompt'
import type { HistoryMessage } from './history'

const service = new Service({ id: 'loop', version: '1.0.0' })

/** A → { sessionId }（loop.run 时记，finish/fail 后发 state.changed 用） */
const sessionsByA = new Map<string, string>()

/**
 * 目标 provider（P3 简化：常量经 env 可配，默认 deepseek；P4 接设置 Pane 后由前端传）。
 * 测试与冒烟经 LLM_PROVIDER 指向本地假上游（openai 位）。
 */
const PROVIDER = process.env.LLM_PROVIDER?.trim() || 'deepseek'

const core = new LoopCore({
  sendLlmRequest(b, sessionId, messages) {
    service.publish('llm.request', { requestId: b, provider: PROVIDER, messages })
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

  // 2) 取历史拼多轮（先落 user 后取，service.append 是异步回执；这里用 payload 文本直接拼最小多轮）
  //    真实多轮在 message.append 回执 / session.get.result 到齐后由 P3.5 细化；P3 先保证一问一答链路通。
  const messages = buildMessages([{ role: 'user', content: text }], DEFAULT_SYSTEM_PROMPT, DEFAULT_MAX_MESSAGES)

  // 3) B 内部 id + A↔B 映射 + 发 llm.request
  const b = newB()
  sessionsByA.set(a, sessionId)
  core.start(a, b, sessionId, messages)

  // 4) state running
  service.publish('loop.state.changed', { requestId: a, sessionId, state: 'running' })
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

// loop.cancel（A）→ 查 B → llm.cancel(B)；等 llm finish{stop} 收尾（不落半截）；未知 A 静默
service.subscribe('loop.cancel', (payload) => {
  const a = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!a) return
  // 发 llm.cancel(B)；等 llm finish{stop} 走 finish 路径（成功不留半截 assistant）
  core.cancel(a) // 未知 A → 静默忽略
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`loop: failed to start: ${String(err)}`)
  process.exit(1)
})
