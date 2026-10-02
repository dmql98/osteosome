/**
 * llm-provider-openai —— 通用 openai 兼容 provider 能力位装配（P2 WS-6）。
 *
 * - 启动即发 `llm.provider.registered { provider, defaultModel, credentialRef, retryPolicy }`（主位据此建路由）；
 * - 收 `llm.provider.request` → 先 credentials 客户端 resolve → streamCompletions 逐块发 `llm.provider.chunk`；
 * - 收 `llm.provider.cancel` → abort → finish{stop} 成功路径。
 *
 * baseURL / 默认模型 / 附加 header 均经 env 可配（见 `./provider`），改环境变量即接入任意 openai 兼容端点。
 */
import { Service } from '@osteosome/service-sdk'
import { attachCredentialClient, CredentialClientError } from '@osteosome/service-sdk'
import { isFinishBlock, listModels, normalizeThinking, type StreamChunk } from '@osteosome/shared'
import { CREDENTIAL_REF, DEFAULT_MODEL, PROVIDER, RETRY_POLICY, streamCompletions, STATIC_MODELS, BASE_URL } from './provider'

const service = new Service({ id: 'llm-provider-openai', version: '1.0.0' })
const credentials = attachCredentialClient(service)

/** 在途请求表（requestId → AbortController） */
const inflight = new Map<string, AbortController>()

/** 注册能力（存在性由插件决定）—— 必须在 service.start() 之后调用：
 *  SDK 在 started=false 时丢弃 publish，模块顶层注册会丢失（WS-9 集成冒烟实证）。 */
function registerCapability(): void {
  service.publish('llm.provider.registered', {
    provider: PROVIDER,
    defaultModel: DEFAULT_MODEL,
    credentialRef: CREDENTIAL_REF,
    retryPolicy: RETRY_POLICY,
  })
}

service.subscribe('llm.provider.request', async (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  if (!requestId || provider !== PROVIDER) return
  const controller = new AbortController()
  inflight.set(requestId, controller)

  // 1) 解析凭证（凭证值只在本进程短暂持有，不进 SSE/前端）
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
      messages: (payload.messages as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[]) ?? [],
      ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
      ...(normalizeThinking(payload.thinking) ? { thinking: normalizeThinking(payload.thinking)! } : {}),
      ...(Array.isArray(payload.tools) && payload.tools.length > 0 ? { tools: payload.tools as never } : {}),
      signal: controller.signal,
      apiKey,
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
  // abort 后 streamCompletions 走成功路径 finish{stop}；若 1s 内未收尾，强制补发
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
    })
    service.publish('llm.models.list.result', { requestId, provider: PROVIDER, models: result.models, catalog: result.source })
  } catch {
    // 凭证都拿不到 → 静态兜底（前端仍可用，只是列表可能不全）
    service.publish('llm.models.list.result', { requestId, provider: PROVIDER, models: staticModels, catalog: 'static' })
  }
})

async function main(): Promise<void> {
  await service.start()
  // 握手完成、订阅已生效后再注册能力（否则 publish 被丢弃，主位拿不到路由）
  registerCapability()
}

main().catch((err: unknown) => {
  console.error(`llm-provider-openai: failed to start: ${String(err)}`)
  process.exit(1)
})
