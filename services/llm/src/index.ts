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
import { isFinishBlock, isDelta, type StreamChunk } from '@osteosome/shared'
import { clearRoutes, resolve, upsert, remove } from './routes'

const service = new Service({ id: 'llm', version: '1.0.0' })

/** 解析 llm.request payload（宽松容错：非法 → 抛错由订阅处兜底转 failed） */
function parseLlmRequest(
  payload: Record<string, unknown>,
): {
  requestId: string
  provider: string
  model?: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  meta?: Record<string, unknown>
} {
  const requestId = typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : ''
  const provider = typeof payload.provider === 'string' && payload.provider ? payload.provider : ''
  if (!requestId || !provider) throw new Error('llm.request: requestId and provider are required')
  if (!Array.isArray(payload.messages)) throw new Error('llm.request: messages (array) is required')
  const messages = payload.messages.map((m) => {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    const normalizedRole: 'system' | 'user' | 'assistant' =
      role === 'system' || role === 'user' || role === 'assistant' ? role : 'user'
    return { role: normalizedRole, content: typeof content === 'string' ? content : String(content ?? '') }
  })
  return {
    requestId,
    provider,
    ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
    messages,
    ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
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
    credentialRef: route.credentialRef,
    retryPolicy: route.retryPolicy,
    meta: { ...(parsed.meta ?? {}), requestId },
  })
})

/** 收 provider.chunk：翻译对外事件（delta → token.streamed；finish → finished/failed） */
const tokenIndexes = new Map<string, number>()
service.subscribe('llm.provider.chunk', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const chunk = payload.chunk as StreamChunk | undefined
  if (!requestId || !chunk || typeof chunk !== 'object') return
  if (isDelta(chunk)) {
    // delta 块无 index：主位按 requestId 维护递增序号（对齐 llm.token.streamed.index 递增契约）
    const index = tokenIndexes.get(requestId) ?? 0
    tokenIndexes.set(requestId, index + 1)
    service.publish('llm.token.streamed', { requestId, token: chunk.text, index })
    return
  }
  if (isFinishBlock(chunk)) {
    tokenIndexes.delete(requestId)
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
  // block-start / block-end / tool-arg-delta：识别降级，不渲染不报错（P2 §0.3）
})

/** 收 llm.cancel：转发 provider.cancel（provider 侧 abort → finish{stop} 成功路径） */
service.subscribe('llm.cancel', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return
  service.publish('llm.provider.cancel', { requestId })
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`llm: failed to start: ${String(err)}`)
  process.exit(1)
})
