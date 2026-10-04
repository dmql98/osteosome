/**
 * LLM 能力主位（P2 WS-4 重写）—— 不 import 任何 provider 实现。
 *
 * 职责：
 * - 维护 provider 路由表（`llm.provider.registered/unregistered` 驱动，见 routes.ts）；
 * - 收前端 `llm.request`：查路由 → 发 `llm.request.started` → 转发 `llm.provider.request`
 *   （凭证引用 / retry 声明由 provider 路由带出，主位**透传**）；
 * - 收 `llm.provider.chunk`：翻译对外事件（delta → `llm.token.streamed`；finish → finished/failed）；
 * - 收 `llm.cancel`：转发 `llm.provider.cancel`。
 *
 * 一次走线（对齐 LLM能力位拆分设计.md §3）：前端 POST /api/command → llm.request →
 * started → provider 注册过？→ llm.provider.request → provider 回 llm.provider.chunk → 翻译对外。
 * 不注册 → 直接 `llm.request.failed { error.code: 'unsupported_provider' }`（存在性由插件决定）。
 */
import { Service } from '@osteosome/service-sdk'
import {
  isFinishBlock,
  isDelta,
  isToolArgDelta,
  isBlockEnd,
  normalizeThinking,
  type StreamChunk,
  type ThinkingEffort,
  type ToolCall,
  type ToolSpec,
} from '@osteosome/shared'
import { clearRoutes, resolve, upsert, remove } from './routes'

const service = new Service({ id: 'llm', version: '1.0.0' })

/** 解析 llm.request payload（宽松容错：非法 → 抛错由订阅处兜底转 failed） */
function parseLlmRequest(
  payload: Record<string, unknown>,
): {
  requestId: string
  provider: string
  model?: string
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: ToolCall[] }[]
  temperature?: number
  thinking?: ThinkingEffort
  tools?: ToolSpec[]
  meta?: Record<string, unknown>
} {
  const requestId = typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : ''
  const provider = typeof payload.provider === 'string' && payload.provider ? payload.provider : ''
  if (!requestId || !provider) throw new Error('llm.request: requestId and provider are required')
  if (!Array.isArray(payload.messages)) throw new Error('llm.request: messages (array) is required')
  const messages = payload.messages.map((m) => {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    const normalizedRole: 'system' | 'user' | 'assistant' | 'tool' =
      role === 'system' || role === 'user' || role === 'assistant' || role === 'tool' ? role : 'user'
    const toolCallId = (m as { toolCallId?: unknown }).toolCallId
    const toolCalls = (m as { toolCalls?: unknown }).toolCalls
    return {
      role: normalizedRole,
      content: typeof content === 'string' ? content : String(content ?? ''),
      ...(typeof toolCallId === 'string' && toolCallId ? { toolCallId } : {}),
      ...(Array.isArray(toolCalls) && toolCalls.length > 0
        ? { toolCalls: toolCalls as ToolCall[] }
        : {}),
    }
  })
  return {
    requestId,
    provider,
    ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
    messages,
    ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
    // 思考强度：宽松归一（非法值静默丢弃 = 不下发，模型走默认）
    ...(normalizeThinking(payload.thinking) ? { thinking: normalizeThinking(payload.thinking) as ThinkingEffort } : {}),
    // 工具定义（P7）：非空即让模型可发起 tool_calls，主位只透传（wire 形状 provider 各自翻）
    ...(Array.isArray(payload.tools) && payload.tools.length > 0
      ? { tools: payload.tools as ToolSpec[] }
      : {}),
    ...(payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
      ? { meta: payload.meta as Record<string, unknown> }
      : {}),
  }
}

/** provider 路由注册/摘除（存在性由插件决定） */
service.subscribe('llm.provider.registered', (payload) => {
  const descriptor = {
    provider: typeof payload.provider === 'string' ? payload.provider : '',
    defaultModel: typeof payload.defaultModel === 'string' ? payload.defaultModel : '',
    credentialRef: typeof payload.credentialRef === 'string' ? payload.credentialRef : '',
    retryPolicy:
      payload.retryPolicy && typeof payload.retryPolicy === 'object'
        ? (payload.retryPolicy as Record<string, unknown>)
        : {},
  }
  if (!descriptor.provider) return
  upsert(descriptor as never)
})

service.subscribe('llm.provider.unregistered', (payload) => {
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  if (provider) remove(provider)
})

/** 收 llm.request：查路由 → started → 转发 provider.request（缺路由 → unsupported_provider） */
service.subscribe('llm.request', (payload) => {
  const p = payload as Record<string, unknown>
  let parsed: ReturnType<typeof parseLlmRequest>
  try {
    parsed = parseLlmRequest(p)
  } catch (err) {
    service.publish('llm.request.failed', {
      requestId: typeof p.requestId === 'string' ? p.requestId : '',
      error: { code: 'invalid_request', message: String(err) },
    })
    return
  }
  const { requestId, provider } = parsed
  const route = resolve(provider)
  if (!route) {
    service.publish('llm.request.failed', {
      requestId,
      error: { code: 'unsupported_provider', message: `no provider service registered for '${provider}'` },
    })
    return
  }
  service.publish('llm.request.started', {
    requestId,
    provider,
    model: parsed.model ?? route.defaultModel,
  })
  service.publish('llm.provider.request', {
    requestId,
    provider,
    model: parsed.model ?? route.defaultModel,
    messages: parsed.messages,
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
    ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
    credentialRef: route.credentialRef,
    retryPolicy: route.retryPolicy,
    meta: { ...(parsed.meta ?? {}), requestId },
  })
})

/** 收 provider.chunk：翻译对外事件（delta → token.streamed；tool 块 → tool_call；finish → finished/failed） */
const tokenIndexes = new Map<string, number>()
/**
 * requestId → 块 id → 工具调用累加器（P7）。
 *
 * provider 按 wire 分帧吐 `tool-arg-delta`（name 只在首帧，arguments 分多帧累积），
 * 主位按块 id 拼装完整 `{ id, name, arguments }`，**块闭合（block-end）即发**
 * `llm.request.tool_call` —— 于是 loop 能在模型续答的同时开始执行工具。
 */
const toolCallsByRequest = new Map<string, Map<string, ToolCall>>()

service.subscribe('llm.provider.chunk', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const chunk = payload.chunk as StreamChunk | undefined
  if (!requestId || !chunk || typeof chunk !== 'object') return
  if (isDelta(chunk)) {
    // delta 块无 index：主位按 requestId 维护递增序号（对齐 llm.token.streamed.index 递增契约）
    const index = tokenIndexes.get(requestId) ?? 0
    tokenIndexes.set(requestId, index + 1)
    // S4：**带上 blockType**。原来不带，下游无法区分思维链与正文，只能一股脑当正文 ——
    // 用 deepseek-reasoner 一类模型时思维链会混进回答正文。
    service.publish('llm.token.streamed', { requestId, token: chunk.text, index, blockType: chunk.blockType })
    return
  }
  if (isToolArgDelta(chunk)) {
    let blocks = toolCallsByRequest.get(requestId)
    if (!blocks) {
      blocks = new Map()
      toolCallsByRequest.set(requestId, blocks)
    }
    const acc = blocks.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' }
    // name 只在首帧携带（后续为 null）；空字符串表示「还没拿到名字」
    if (typeof chunk.name === 'string' && chunk.name.length > 0) acc.name = chunk.name
    acc.arguments += chunk.arguments
    blocks.set(chunk.id, acc)
    return
  }
  if (isBlockEnd(chunk) && chunk.blockType === 'tool_call') {
    const blocks = toolCallsByRequest.get(requestId)
    const acc = blocks?.get(chunk.id)
    if (blocks && acc) {
      blocks.delete(chunk.id)
      // 没拿到工具名就不透出（残缺调用执行不了；P2 WS-10 记的 wire 坑防御）
      if (acc.name) service.publish('llm.request.tool_call', { requestId, toolCall: { ...acc } })
    }
    return
  }
  if (isFinishBlock(chunk)) {
    tokenIndexes.delete(requestId)
    // 未闭合的块（上游异常断开）不补发 —— 宁可少一次工具执行，也不要半个参数
    toolCallsByRequest.delete(requestId)
    if (chunk.error) {
      service.publish('llm.request.failed', { requestId, error: chunk.error })
      return
    }
    service.publish('llm.request.finished', {
      requestId,
      finishReason: chunk.finishReason,
      ...(chunk.usage ? { usage: chunk.usage } : {}),
    })
  }
  // block-start：识别降级，不渲染不报错（P2 §0.3）；tool 块的名字/参数走 tool-arg-delta
})

/** 收 llm.cancel：转发 provider.cancel（provider 侧 abort → finish{stop} 成功路径） */
service.subscribe('llm.cancel', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return
  service.publish('llm.provider.cancel', { requestId })
})

/**
 * 主动问一次「现在有哪些 provider」。
 *
 * ## 为什么路由方要主动问
 *
 * 路由表是由 llm.provider.registered **事件**喂起来的，而事件只在订阅方就位后才收得到。
 * 谁先启动是偶然的（目录遍历顺序、插件安装顺序都算），于是有两种结局：
 *
 * - provider 先启动 → 本服务订阅时事件已经发完 → 路由表空 → 请求一律 unsupported_provider；
 * - 本服务先启动 → provider 启动时自然被听到 → 没问题。
 *
 * 前端有同一个坑，解法是挂载后发 llm.provider.reannounce（见 useLlmProviders.ts）。
 * 这里是那件事的另一半：**主位自己上线时也要问一次**，否则「谁先启动」就成了成败条件。
 * 有了这一句，启动顺序不再是任何人的隐式依赖。
 */
async function main(): Promise<void> {
  await service.start()
  // 订阅已就位，现在问一次「当前有哪些 provider」（早发一瞬就漏掉先启动的那些）
  service.publish('llm.provider.reannounce', {})
}

main().catch((err: unknown) => {
  console.error(`llm: failed to start: ${String(err)}`)
  process.exit(1)
})
