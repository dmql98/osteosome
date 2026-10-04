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
 * env 覆盖：`<ID_UPPER>_BASE_URL` / `<ID_UPPER>_MODEL`。
 *
 * 凭证与自填端点有三个来源，优先级从高到低：
 * 1. **env**：`<ID_UPPER>_API_KEY`（部署者显式注入，脚本 / CI 用）
 * 2. **Core 凭证库**：用户在设置窗存的密钥（`credential.saved` 带 `provider` 字段，据此归类）
 * 3. **Core 偏好** `llm.vendorOverrides`：用户在设置窗填的自填端点
 *
 * 且**运行期会重算**：收到 `credential.saved` / `credential.deleted` 就重算实例列表并增删注册 ——
 * 「存在性由配置决定」必须当场生效，否则用户在设置窗加了密钥还得重启进程才能看到下拉里多一家。
 * 读取走 Core 的点对点特权 RPC（`preferences.get` / `credentials.list`），不经总线。
 */
import { Service } from '@osteosome/service-sdk'
import { attachCredentialClient, CredentialClientError, loadPluginJson } from '@osteosome/service-sdk'
import {
  isFinishBlock,
  listModels,
  normalizeThinking,
  parseVendorCatalog,
  presetsForWire,
  type StreamChunk,
  type StreamError,
  type ToolSpec,
  type VendorPreset,
} from '@osteosome/shared'
import {
  buildVendorInstances,
  SERVED_WIRE,
  toRegisteredPayload,
  type CredentialSources,
  type VendorInstance,
} from './instances'
import { streamCompletions } from './provider'

const service = new Service({ id: 'llm-provider-openai', version: '1.1.0' })
const credentials = attachCredentialClient(service)

/** 插件自带目录文件（相对 `plugins/models/`）。Core 授予只读，边界在 Core 那边 */
const CATALOG_PATH = 'catalog.json'

/** 在途请求表（requestId → AbortController） */
const inflight = new Map<string, AbortController>()

/**
 * provider 名 → 实例。
 *
 * 必须在 `service.start()` **之后**填充：SDK 在 started=false 时丢弃 publish，
 * 模块顶层注册会丢失（P2 WS-9 集成冒烟实证）。
 */
const instances = new Map<string, VendorInstance>()

/** Core 凭证库快照：`厂商 id → 凭证 id`（启动时读一次，之后由事件增量维护） */
const credentialIdByProvider = new Map<string, string>()

/** Core 偏好快照（`llm.vendorOverrides`）；设置窗写入后需要重启或事件触发才刷新 */
let preferences: { vendorOverrides?: unknown } = {}

/**
 * 本进程服务的厂商预设 —— 来自插件自带的 `catalog.json`（P5）。
 *
 * 刻意**没有默认值**：数据只有一个来源，就是那份文件。留一个编译期兜底表等于
 * 把它又抄回代码里，而两份数据的漂移症状是「界面上有的厂商，服务不认」。
 *
 * 读取走 Core 的 `plugins.readFile`（点对点只读特权，与 `preferences.get` 同一纪律）。
 */
let catalogPresets: VendorPreset[] = []

/**
 * 读并校验 `catalog.json`。
 *
 * ## 三种失败，三种处置
 *
 * · **文件读不到**（服务不属于任何插件 / Core 没这个能力）→ **空表 + 警告**。
 *   那样这个进程注册不到任何厂商，用户看到「下拉是空的」，而日志里有一行说明。
 *   这里不 fail closed 到「进程起不来」：一个模型插件没带目录文件时把整个
 *   LLM 能力位打死，代价远大于「暂时没有厂商可选」。
 * · **JSON 坏了** → 抛。`loadPluginJson` 故意不吞这个：文件在、却读不出内容时
 *   静默继续，等于把「这家怎么不出现」推到用户面前再查。
 * · **有条目坏了** → 逐条警告、其余照用。一家厂商写错 `baseUrl` 不该让另外 11 家消失。
 */
async function loadCatalog(): Promise<void> {
  const loaded = await loadPluginJson(service, CATALOG_PATH, { required: false })
  if (!loaded.ok) {
    console.warn(
      `llm-provider-openai: ${CATALOG_PATH} unavailable (${loaded.reason}) — no vendor presets`,
    )
    catalogPresets = []
    return
  }
  const { vendors, errors } = parseVendorCatalog(loaded.value)
  for (const why of errors) console.warn(`llm-provider-openai: ${CATALOG_PATH} — ${why}`)
  catalogPresets = vendors
  if (vendors.length === 0) {
    console.warn(`llm-provider-openai: ${CATALOG_PATH} has no usable vendor entries`)
  }
}

/**
 * 从 Core 的两个特权通道读配置。
 *
 * 为什么走 RPC 而不是读文件 / 上总线：
 * - 与 `credentials.get` 同一套「点对点特权读」纪律，**不经总线、不落事件**；
 * - 服务不知道也不该知道 Core 的 dataDir 布局。
 *
 * 读不到就退化成「只有 env」—— 宁可少几家可见，也不要因为配置通道故障而起不来。
 */
async function loadConfigFromCore(): Promise<void> {
  try {
    const listed = await service.call<{ credentials?: Array<{ id?: string; provider?: string }> }>(
      'credentials.list',
    )
    credentialIdByProvider.clear()
    for (const item of listed?.credentials ?? []) {
      if (typeof item?.id === 'string' && typeof item?.provider === 'string' && item.provider) {
        credentialIdByProvider.set(item.provider, item.id)
      }
    }
  } catch (err) {
    console.warn(`llm-provider-openai: credentials.list unavailable (${String(err)}) — env-only`)
  }
  try {
    const read = await service.call<{ preferences?: { llm?: { vendorOverrides?: unknown } } }>('preferences.get')
    preferences = read?.preferences?.llm ?? {}
  } catch (err) {
    console.warn(`llm-provider-openai: preferences.get unavailable (${String(err)}) — env-only`)
  }
}

function currentSources(): CredentialSources {
  return { env: process.env, byProvider: new Map(credentialIdByProvider), preferences }
}

/**
 * 重算实例列表并把差异反映到总线：新增的注册、消失的注销。
 *
 * 「消失」也要发 `llm.provider.unregistered` —— 主位据此摘路由，前端据此摘状态行。
 * 只增不减的话，删掉密钥后下拉里还挂着一家永远会 401 的 provider。
 */
function reconcile(): { added: string[]; removed: string[] } {
  const rejected: Array<{ id: string; api: string }> = []
  const built = buildVendorInstances(
    currentSources(),
    presetsForWire(SERVED_WIRE, catalogPresets),
    rejected,
  )
  const next = new Map(built.map((i) => [i.id, i]))

  const added: string[] = []
  for (const [id, inst] of next) {
    const prev = instances.get(id)
    // 凭证来源或端点变了也要重发（前端展示的 credentialRef / defaultModel 会变）
    if (!prev || prev.credentialRef !== inst.credentialRef || prev.baseUrl !== inst.baseUrl) {
      instances.set(id, inst)
      service.publish('llm.provider.registered', toRegisteredPayload(inst))
      added.push(id)
    } else {
      instances.set(id, inst)
    }
  }

  const removed: string[] = []
  for (const id of [...instances.keys()]) {
    if (next.has(id)) continue
    instances.delete(id)
    service.publish('llm.provider.unregistered', { provider: id })
    removed.push(id)
  }

  if (instances.size === 0) {
    console.warn(
      `llm-provider-openai: no vendor configured (set one of *_API_KEY, or add a provider in Settings)`,
    )
  }
  for (const item of rejected) {
    console.warn(
      `llm-provider-openai: custom endpoint '${item.id}' declares wire '${item.api}', ` +
        `which this process does not implement (served wire: '${SERVED_WIRE}') — skipped. ` +
        `Install the matching llm-provider-${item.api} plugin, or set "api": "${SERVED_WIRE}".`,
    )
  }
  return { added, removed }
}

/**
 * 重播全部注册（S8 之后）：让**后打开的页面**也能拿到当前清单。
 *
 * 前端对 provider 清单是纯事件驱动的，而注册事件在握手完成时就发完了。
 * 没有这条，任何在启动之后才挂载的组件都会把已连上的服务显示成「未连接」——
 * 症状是「模型配置页里 LM Studio 明明开着，却显示未连接，点「直接连」也没反应」。
 *
 * 刻意不新增 HTTP 端点：provider 实例表在**服务进程里**，Core 拿不到，
 * 而总线本来就是服务之间唯一的通道 —— 所以走命令比造一条 Core 专用查询链更正。
 */
service.subscribe('llm.provider.reannounce', () => {
  for (const inst of instances.values()) {
    service.publish('llm.provider.registered', toRegisteredPayload(inst))
  }
})

/** 注册本进程所有「已配置」的厂商实例 —— 握手完成、订阅生效后再调用 */
async function registerCapabilities(): Promise<void> {
  await loadConfigFromCore()
  reconcile()
}

// 「存在性由配置决定」要当场生效：用户在设置窗存/删密钥后立刻重算，不用重启进程。
service.subscribe('credential.saved', (payload) => {
  const id = typeof payload.id === 'string' ? payload.id : ''
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  if (!id || !provider) return
  credentialIdByProvider.set(provider, id)
  const { added } = reconcile()
  if (added.length > 0) console.log(`llm-provider-openai: registered via credential: ${added.join(', ')}`)
})

service.subscribe('credential.deleted', (payload) => {
  const id = typeof payload.id === 'string' ? payload.id : ''
  if (!id) return
  // 只有当被删的正是「这家当前在用的那条」才摘掉；删了另一条不该影响已注册的厂商
  let hit = false
  for (const [provider, cid] of [...credentialIdByProvider]) {
    if (cid !== id) continue
    credentialIdByProvider.delete(provider)
    hit = true
  }
  if (!hit) return
  // env 兜底：env 还在的话这一家仍然可用，不该注销
  const { removed } = reconcile()
  if (removed.length > 0) console.log(`llm-provider-openai: unregistered (credential removed): ${removed.join(', ')}`)
})

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
  // 厂商目录要在**注册能力之前**读好：注册用的实例列表就是从它算出来的。
  // 顺序反了的话第一轮 reconcile 会基于空表注册，随后又全部注销 —— 用户会看到
  // 「模型下拉闪了一下才出来」，而日志里两次事件都合法。
  await loadCatalog()
  // 握手完成、订阅已生效后再注册能力（否则 publish 被丢弃，主位拿不到路由）
  await registerCapabilities()
}

main().catch((err: unknown) => {
  console.error(`llm-provider-openai: failed to start: ${String(err)}`)
  process.exit(1)
})
