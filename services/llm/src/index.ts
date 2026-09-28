/**
 * LLM 服务入口（P2 §2 WS-1 / WS-3 装配）。
 *
 * 订阅 `llm.request` / `llm.cancel`：
 * - `llm.request` → started → 解析凭证 → resolve adapter → 逐块流式发布 → finished / failed
 * - `llm.cancel { requestId }` → abort 对应在途请求；成功取消走 finished{stop}（不发 failed）
 * - 同一 service 进程内并发请求互不覆盖（requestId 关联 in-flight 表）
 */
import { Service } from '@osteosome/service-sdk'
import { DEFAULT_RETRY_POLICY, type StreamChunk, type StreamError, type Usage } from '@osteosome/shared'
import { openrouterAdapter } from './adapter/openrouter'
import { register, resolve } from './adapter/registry'
import { resolveApiKey, CredentialError } from './credentials/resolver'

const service = new Service({ id: 'llm', version: '1.0.0' })

register(openrouterAdapter)

interface Inflight {
  abort: AbortController
}

const inflight = new Map<string, Inflight>()

/** 断言 payload 是 llm.request 形状；非法 → 抛错由调用方兜底 */
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
  if (!requestId || !provider) {
    throw new Error(`llm.request: requestId and provider are required`)
  }
  if (!Array.isArray(payload.messages)) {
    throw new Error(`llm.request: messages (array) is required`)
  }
  const messages = payload.messages.map(
    (m): { role: 'system' | 'user' | 'assistant'; content: string } => {
      const role = (m as { role?: unknown }).role
      const content = (m as { content?: unknown }).content
      const normalizedRole: 'system' | 'user' | 'assistant' =
        role === 'system' || role === 'user' || role === 'assistant' ? role : 'user'
      return {
        role: normalizedRole,
        content: typeof content === 'string' ? content : String(content ?? ''),
      }
    },
  )
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

service.subscribe('llm.request', (payload) => {
  const p = payload as Record<string, unknown>
  let parsed: ReturnType<typeof parseLlmRequest>
  try {
    parsed = parseLlmRequest(p)
  } catch (err) {
    const requestId = typeof p.requestId === 'string' ? p.requestId : ''
    service.publish('llm.request.failed', {
      requestId,
      error: { code: 'invalid_request', message: String(err) },
    })
    return
  }
  void runRequest(parsed)
})

service.subscribe('llm.cancel', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return
  const entry = inflight.get(requestId)
  if (!entry) return // 已结束 / 不存在 → 静默忽略
  entry.abort.abort()
  // 取消是成功路径：abort 后适配器 yield finish{stop}，runRequest 负责收尾；
  // 若 1s 内未收到 finish，这里强制补发（§3.4「1s 上限」）
  const forceTimer = setTimeout(() => {
    if (inflight.delete(requestId)) {
      service.publish('llm.request.finished', { requestId, finishReason: 'stop' })
    }
  }, 1000)
  forceTimer.unref?.()
})

async function runRequest(
  req: ReturnType<typeof parseLlmRequest>,
): Promise<void> {
  const { requestId } = req
  const controller = new AbortController()
  inflight.set(requestId, { abort: controller })

  let providerModel = req.model
  try {
    const adapter = resolve(req.provider)
    providerModel = req.model ?? adapter.defaultModel
    service.publish('llm.request.started', {
      requestId,
      provider: req.provider,
      model: providerModel,
    })

    const apiKey = resolveApiKey('env:OPENROUTER_API_KEY')
    const ctx = {
      apiKey,
      retryPolicy: DEFAULT_RETRY_POLICY,
      signal: controller.signal,
    }

    let index = 0
    let usage: Usage | undefined
    let finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' = 'stop'
    let failed = false

    for await (const chunk of adapter.stream(
      {
        provider: req.provider,
        ...(req.model ? { model: req.model } : {}),
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        meta: { ...(req.meta ?? {}), requestId },
      },
      ctx,
    )) {
      if (!isFinish(chunk)) continue
      finishReason = chunk.finishReason
      usage = chunk.usage
      if (chunk.error) {
        failed = true
        // 硬错误（非瞬态 / 无 retry）：直接 failed，不再等后续块
        service.publish('llm.request.failed', {
          requestId,
          error: { code: chunk.error.code, message: chunk.error.message },
        })
      }
    }

    if (inflight.delete(requestId)) {
      if (!failed) {
        service.publish('llm.request.finished', {
          requestId,
          finishReason,
          ...(usage ? { usage } : {}),
        })
      }
    }
  } catch (err) {
    inflight.delete(requestId)
    const error: StreamError =
      err instanceof CredentialError
        ? { code: err.code, message: err.message }
        : { code: 'network', message: String(err) }
    service.publish('llm.request.failed', { requestId, error })
  }
}

function isFinish(
  chunk: StreamChunk,
): chunk is Extract<StreamChunk, { kind: 'finish' }> {
  return chunk.kind === 'finish'
}

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`llm: failed to start: ${String(err)}`)
  process.exit(1)
})
