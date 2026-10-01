/**
 * llm-provider-anthropic —— provider 能力位装配（P4 WS-3）。
 *
 * 与 openai 系同构：启动注册能力 → 收 provider.request → 解析凭证 → 流式发 provider.chunk → cancel abort。
 * 差异在 provider.ts（messages API wire），装配层保持一致。
 */
import { Service } from '@osteosome/service-sdk'
import { attachCredentialClient, CredentialClientError } from '@osteosome/service-sdk'
import { isFinishBlock, listModels, type StreamChunk } from '@osteosome/shared'
import {
  STATIC_MODELS,
  ANTHROPIC_VERSION,
  BASE_URL,
  CREDENTIAL_REF,
  DEFAULT_MODEL,
  PROVIDER,
  RETRY_POLICY,
  streamCompletions,
} from './provider'

const service = new Service({ id: 'llm-provider-anthropic', version: '1.0.0' })
const credentials = attachCredentialClient(service)

/** 在途请求表（requestId → AbortController） */
const inflight = new Map<string, AbortController>()

service.publish('llm.provider.registered', {
  provider: PROVIDER,
  defaultModel: DEFAULT_MODEL,
  credentialRef: CREDENTIAL_REF,
  retryPolicy: RETRY_POLICY,
})

service.subscribe('llm.provider.request', async (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  if (!requestId || provider !== PROVIDER) return
  const controller = new AbortController()
  inflight.set(requestId, controller)

  // 1) 解析凭证（apiKey 只在本进程内存，不进 SSE/事件）
  let apiKey: string
  try {
    const resolved = await credentials.resolve(CREDENTIAL_REF, requestId)
    apiKey = resolved.apiKey
  } catch (err) {
    inflight.delete(requestId)
    const error: import('@osteosome/shared').StreamError =
      err instanceof CredentialClientError && err.error
        ? err.error
        : { code: 'missing_credential', message: String(err) }
    service.publish('llm.provider.chunk', {
      requestId,
      chunk: { kind: 'finish', finishReason: 'error', error } satisfies StreamChunk,
    })
    return
  }

  // 2) 流式上游 → 逐块发 provider.chunk
  try {
    for await (const chunk of streamCompletions({
      requestId,
      model: typeof payload.model === 'string' ? payload.model : undefined,
      messages: (payload.messages as { role: 'system' | 'user' | 'assistant'; content: string }[]) ?? [],
      ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
      signal: controller.signal,
      apiKey,
      baseURL: BASE_URL,
    })) {
      if (inflight.get(requestId) !== controller) return
      service.publish('llm.provider.chunk', { requestId, chunk })
      if (isFinishBlock(chunk)) break
    }
  } catch (err) {
    service.publish('llm.provider.chunk', {
      requestId,
      chunk: { kind: 'finish', finishReason: 'error', error: { code: 'network', message: String(err) } } satisfies StreamChunk,
    })
  } finally {
    inflight.delete(requestId)
  }
})

service.subscribe('llm.provider.cancel', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const controller = inflight.get(requestId)
  if (!controller) return
  controller.abort()
  const timer = setTimeout(() => {
    if (inflight.delete(requestId)) {
      service.publish('llm.provider.chunk', {
        requestId,
        chunk: { kind: 'finish', finishReason: 'stop' } satisfies StreamChunk,
      })
    }
  }, 1000)
  timer.unref?.()
})

/**
 * 模型目录（P4 WS-3）—— 能力位：provider 自己知道有哪些模型。
 * 拉上游 /models；失败/超时 → 静态兜底（source:'static'，前端提示列表可能不全）。
 */
service.subscribe('llm.models.list', async (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const target = typeof payload.provider === 'string' ? payload.provider : ''
  if (!requestId || target !== PROVIDER) return // 只回自己那份
  const staticModels = STATIC_MODELS
  try {
    const { apiKey } = await credentials.resolve(CREDENTIAL_REF, requestId)
    const result = await listModels({
      baseURL: BASE_URL,
      apiKey,
      staticModels,
      timeoutMs: 5000,
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    })
    service.publish('llm.models.list.result', { requestId, provider: PROVIDER, models: result.models, source: result.source })
  } catch {
    // 凭证都拿不到 → 静态兜底（前端仍可用，只是列表可能不全）
    service.publish('llm.models.list.result', { requestId, provider: PROVIDER, models: staticModels, source: 'static' })
  }
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`llm-provider-anthropic: failed to start: ${String(err)}`)
  process.exit(1)
})
