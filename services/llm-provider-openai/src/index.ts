/**
 * llm-provider-openai —— **通用 openai 兼容 provider 能力位**（P2 WS-6 建包 · S1 改多实例）。
 *
 * 一个进程服务**多家** openai 兼容厂商：启动时按 `shared` 的厂商预设表 + env 配置算出实例列表，
 * 逐个 publish `llm.provider.registered`（主位据此建路由），请求按 `payload.provider` 取对应实例的
 * baseUrl / 凭证引用。
 *
 * - 「加一家厂商 = 预设表加一行」，不再需要复制一份 provider.ts 或多起一个进程（见 `instances.ts` 头注）；
 * - wire 翻译只有一份（都是 openai 兼容），差异在 `provider.ts` 内消化；
 * - 免凭证的本地端点（ollama / vllm / lm-studio）恒注册；其余厂商**未配置凭证即不注册** ——
 *   语义等价于「没装」，前端下拉里不会出现它。
 *
 * env 覆盖：`<ID_UPPER>_BASE_URL` / `<ID_UPPER>_MODEL`；用户自填端点走 `LLM_VENDORS_EXTRA`
 * （JSON 数组，S3 由设置窗写入后改为 preferences）。
 */
import { Service } from '@osteosome/service-sdk'
import { attachCredentialClient, CredentialClientError } from '@osteosome/service-sdk'
import {
  isFinishBlock,
  listModels,
  normalizeThinking,
  type StreamChunk,
  type StreamError,
  type ToolSpec,
} from '@osteosome/shared'
import { buildVendorInstances, SERVED_WIRE, toRegisteredPayload, type VendorInstance } from './instances'
import { streamCompletions } from './provider'

const service = new Service({ id: 'llm-provider-openai', version: '1.1.0' })
const credentials = attachCredentialClient(service)

/** 在途请求表（requestId → AbortController） */
const inflight = new Map<string, AbortController>()

/**
 * provider 名 → 实例。
 *
 * 必须在 `service.start()` **之后**填充：SDK 在 started=false 时丢弃 publish，
 * 模块顶层注册会丢失（P2 WS-9 集成冒烟实证）。
 */
const instances = new Map<string, VendorInstance>()

/** 注册本进程所有「已配置」的厂商实例 —— 握手完成、订阅生效后再调用 */
function registerCapabilities(): void {
  const rejected: Array<{ id: string; api: string }> = []
  const built = buildVendorInstances(process.env, undefined, rejected)
  for (const inst of built) {
    instances.set(inst.id, inst)
    service.publish('llm.provider.registered', toRegisteredPayload(inst))
  }
  if (built.length === 0) {
    // 一家都没有 → 不是崩溃，但要说清楚原因（多半是没配任何 *_API_KEY）
    console.warn(
      `llm-provider-openai: no vendor configured (set one of *_API_KEY, or LLM_VENDORS_EXTRA for a custom endpoint)`,
    )
  }
  // 自填端点声明了本进程不实现的 wire → 明确告警，不静默丢弃（否则用户以为装上了）
  for (const item of rejected) {
    console.warn(
      `llm-provider-openai: custom endpoint '${item.id}' declares wire '${item.api}', ` +
        `which this process does not implement (served wire: '${SERVED_WIRE}') — skipped. ` +
        `Install the matching llm-provider-${item.api} plugin, or set "api": "${SERVED_WIRE}".`,
    )
  }
}

service.subscribe('llm.provider.request', async (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  if (!requestId) return
  const instance = instances.get(provider)
  // 没注册的厂商一律不回：本进程不认识它，主位路由不到这里；真收到就是不该发生
  if (!instance) return
  const controller = new AbortController()
  inflight.set(requestId, controller)

  // 1) 解析凭证（凭证值只在本进程短暂持有，不进 SSE/前端）
  let apiKey = ''
  if (instance.credentialRef) {
    try {
      const resolved = await credentials.resolve(instance.credentialRef, requestId)
      apiKey = resolved.apiKey
    } catch (err) {
      inflight.delete(requestId)
      const error: StreamError =
        err instanceof CredentialClientError && err.error
          ? err.error
          : { code: 'missing_credential', message: String(err) }
      service.publish('llm.provider.chunk', {
        requestId,
        chunk: { kind: 'finish', finishReason: 'error', error } satisfies StreamChunk,
      })
      return
    }
  }

  // 2) 流式上游 → 逐块发 provider.chunk（按实例的 baseUrl）
  try {
    for await (const chunk of streamCompletions({
      requestId,
      baseURL: instance.baseUrl,
      model: typeof payload.model === 'string' ? payload.model : undefined,
      messages: (payload.messages as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[]) ?? [],
      ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
      ...(normalizeThinking(payload.thinking) ? { thinking: normalizeThinking(payload.thinking)! } : {}),
      ...(Array.isArray(payload.tools) && payload.tools.length > 0 ? { tools: payload.tools as ToolSpec[] } : {}),
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
 * 按实例的 baseUrl 拉上游 `/models`；失败/超时/无凭证 → 该实例的静态兜底（`catalog:'static'`）。
 */
service.subscribe('llm.models.list', async (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const target = typeof payload.provider === 'string' ? payload.provider : ''
  if (!requestId) return
  const instance = instances.get(target)
  if (!instance) return // 只回自己负责的厂商
  const staticModels = instance.staticModels
  const fallback = (): void => {
    service.publish('llm.models.list.result', {
      requestId,
      provider: target,
      models: staticModels,
      catalog: 'static',
    })
  }
  if (!instance.credentialRef) {
    // 免凭证本地端点：直接拉（listModels 对空 apiKey 不加 Authorization）
    const result = await listModels({ baseURL: instance.baseUrl, apiKey: '', staticModels, timeoutMs: 5000 })
    service.publish('llm.models.list.result', { requestId, provider: target, models: result.models, catalog: result.source })
    return
  }
  try {
    const { apiKey } = await credentials.resolve(instance.credentialRef, requestId)
    const result = await listModels({ baseURL: instance.baseUrl, apiKey, staticModels, timeoutMs: 5000 })
    service.publish('llm.models.list.result', { requestId, provider: target, models: result.models, catalog: result.source })
  } catch {
    // 凭证都拿不到 → 静态兜底（前端仍可用，只是列表可能不全）
    fallback()
  }
})

async function main(): Promise<void> {
  await service.start()
  // 握手完成、订阅已生效后再注册能力（否则 publish 被丢弃，主位拿不到路由）
  registerCapabilities()
}

main().catch((err: unknown) => {
  console.error(`llm-provider-openai: failed to start: ${String(err)}`)
  process.exit(1)
})
