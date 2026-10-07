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
 * ## 用户数据归本进程（`userData/plugin/models/`）
 *
 * 接入清单与密钥都由**这个服务持有**（`preferences.json` + `credentials.json`）：
 * - 不再向 Core 读 `preferences.get` / `credentials.list`，也不再等 `credentials.resolve` 那一跳；
 * - 明文密钥只在本进程内存与那个文件里 —— 比「Core 保管 → 凭证服务转发 → provider」短两跳，
 *   而**红线没变**：明文永不入事件 / SSE / 日志，回给前端的一律掩码；
 * - 前端经总线读写（`models.prefs.*` / `models.credentials.*`），Core 只转发不落盘。
 *
 * 配置有两个来源，优先级从高到低：
 * 1. **env**：`<ID_UPPER>_API_KEY`（部署者显式注入，脚本 / CI 用）
 * 2. **本插件的用户数据**：`credentials.json` 里用户在设置窗存的密钥（按 `provider` 归类）
 *    与 `preferences.json` 里的自填端点
 *
 * 且**运行期会重算**：`models.credentials.put/delete`、`models.prefs.set` 一到就重算实例列表并增删注册 ——
 * 「存在性由配置决定」必须当场生效，否则用户在设置窗加了密钥还得重启进程才能看到下拉里多一家。
 */
import { Service } from '@osteosome/service-sdk'
import { loadPluginJson } from '@osteosome/service-sdk'
import {
  isFinishBlock,
  listModels,
  normalizeThinking,
  parseVendorCatalog,
  presetsForWire,
  type MaskedCredential,
  type ModelsPrefs,
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
import { ModelsStore, ModelsStoreError } from './store'

const service = new Service({ id: 'llm-provider-openai', version: '1.2.0' })

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

/**
 * 本插件的用户数据仓库 —— `service.start()` 之后才有 `service.dataDir`，所以那时才建。
 *
 * 顶层留 `null` 而不是造一个空壳：空壳会让「密钥都在哪」这个问题有两个答案，
 * 而「建仓库必须晚于 start」正是本文件最容易写错的地方。
 */
let store: ModelsStore | null = null

/** 接入清单快照（`vendorOverrides` 参与注册计算；另两个键是 UI 的消费方） */
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
 * 打开自己的用户数据目录（`userData/plugin/models/`）。
 *
 * ## 为什么是「读自己的文件」而不是「问 Core」
 *
 * 原来这里是两条 Core 特权 RPC（`credentials.list` + `preferences.get`），
 * 因为那时候密钥归 Core 保管。密钥归使用方插件之后，这个理由消失了：
 * Core 拿到这些数据对它没有任何用处（它不解析厂商、不发请求），
 * 却让密钥与接入清单都多了一个进程经手。
 *
 * ## 失败处置
 *
 * 目录建不起来 → **抛**（`ModelsStore` 内部抛）。这件事不能 fail-open：
 * 静默退化成「空偏好」的话，用户会看到「我明明连了 LM Studio，怎么下拉里没有」，
 * 而日志里只有一行 warn。宁可这个服务起不来 —— 状态面板会明说哪个服务 failed。
 *
 * 文件内容坏掉 → **不抛**（`prefsCorrupted` / `credsCorrupted` 标记出来并告警）：
 * 一个坏文件不该连累用户连不上已经能用的本地端点。
 */
function openStore(): void {
  store = new ModelsStore(service.dataDir)
  preferences = { vendorOverrides: store.getPrefs().vendorOverrides }
  const { prefs, credentials } = store.files
  console.log(`llm-provider-openai: user data ${prefs}${store.prefsCorrupted ? ' (CORRUPTED)' : ''}`)
  console.log(`llm-provider-openai: credentials ${credentials}${store.credsCorrupted ? ' (CORRUPTED)' : ''}`)
  if (store.prefsCorrupted) console.warn(`llm-provider-openai: ${prefs} is corrupted — treated as empty`)
  if (store.credsCorrupted) console.warn(`llm-provider-openai: ${credentials} is corrupted — treated as empty`)
}

function currentSources(): CredentialSources {
  return { env: process.env, byProvider: store ? store.credentialIdByProvider() : new Map(), preferences }
}

/**
 * 解析凭证引用 → 明文。**只在本进程**，结果不进事件 / 日志 / 返回值。
 *
 * 两种 ref：
 * - `env:<VAR>` —— 本进程环境变量（部署者注入）
 * - `file:<id>` —— 本插件 `credentials.json` 里的那一条
 *
 * 认不出的 scheme 抛错而不是给空串：空 apiKey 打过去换来的是上游 401，
 * 那条报错会指向「厂商配错了」，而真实原因是引用格式坏了 —— 指向错的方向更难查。
 */
function resolveApiKey(ref: string): string {
  if (!ref) return ''
  const sep = ref.indexOf(':')
  const scheme = sep > 0 ? ref.slice(0, sep) : ''
  const rest = sep > 0 ? ref.slice(sep + 1) : ''
  if (scheme === 'env') return process.env[rest] ?? ''
  if (scheme === 'file') {
    if (!store) throw new ModelsStoreError('not_found', 'store not open')
    return store.credentialValue(rest)
  }
  throw new ModelsStoreError('not_found', `unsupported credentialRef scheme: '${scheme || ref}'`)
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
  openStore()
  reconcile()
}

// ── 本插件用户数据的命令面（owner = 本进程）────────────────────────
//
// 前端（模型接入面板）经 `/api/command` → 总线到这里读写；Core 只转发，不持有这些数据。
//
// 为什么每次变更都**重播整份**而不是发增量：订阅方可能晚于本进程启动（那一刻的增量早发完了），
// 而「拿到全量就不需要补偿逻辑」这条性质比省几个字节重要得多。

service.subscribe('models.prefs.get', () => {
  if (!store) return
  service.publish('models.prefs.state', { prefs: store.getPrefs() })
})

service.subscribe('models.prefs.set', (payload) => {
  if (!store) return
  const patch = (payload as { patch?: unknown }).patch
  if (!patch || typeof patch !== 'object') {
    service.publish('models.prefs.state', { prefs: store.getPrefs() })
    return
  }
  try {
    const next = store.patchPrefs(patch as Partial<ModelsPrefs>)
    // 自填端点变了要重算实例（端点/凭证引用是注册内容的一部分）
    preferences = { vendorOverrides: next.vendorOverrides }
    reconcile()
    service.publish('models.prefs.state', { prefs: store.getPrefs() })
  } catch (err) {
    console.error(`llm-provider-openai: models.prefs.set failed: ${String(err)}`)
    service.publish('models.prefs.state', { prefs: store.getPrefs() })
  }
})

service.subscribe('models.credentials.list', () => {
  if (!store) return
  service.publish('models.credentials.state', { credentials: store.maskedCredentials() })
})

service.subscribe('models.credentials.put', (payload) => {
  if (!store) return
  const p = payload as { id?: string; name?: string; provider?: string; value?: string }
  if (typeof p.value !== 'string' || !p.value) {
    console.warn('llm-provider-openai: models.credentials.put without value — ignored')
    service.publish('models.credentials.state', { credentials: store.maskedCredentials() })
    return
  }
  try {
    store.putCredential({
      ...(typeof p.id === 'string' ? { id: p.id } : {}),
      name: typeof p.name === 'string' ? p.name : '',
      provider: typeof p.provider === 'string' ? p.provider : '',
      value: p.value,
    })
  } catch (err) {
    // 写盘失败必须让用户知道（密钥没存住 = 以为存住了其实没有）
    console.error(`llm-provider-openai: models.credentials.put failed: ${String(err)}`)
  }
  const { added, removed } = reconcile()
  if (added.length > 0) console.log(`llm-provider-openai: registered via credential: ${added.join(', ')}`)
  if (removed.length > 0) console.log(`llm-provider-openai: unregistered: ${removed.join(', ')}`)
  service.publish('models.credentials.state', { credentials: store.maskedCredentials() })
})

service.subscribe('models.credentials.delete', (payload) => {
  if (!store) return
  const id = typeof (payload as { id?: string }).id === 'string' ? (payload as { id: string }).id : ''
  if (id) {
    try {
      store.deleteCredential(id)
    } catch (err) {
      console.error(`llm-provider-openai: models.credentials.delete failed: ${String(err)}`)
    }
    reconcile()
  }
  service.publish('models.credentials.state', { credentials: store.maskedCredentials() })
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
      apiKey = resolveApiKey(instance.credentialRef)
      if (!apiKey) throw new ModelsStoreError('not_found', `credential '${instance.credentialRef}' has no value`)
    } catch (err) {
      inflight.delete(requestId)
      const error: StreamError =
        err instanceof ModelsStoreError && err.reason
          ? { code: 'missing_credential', message: err.message }
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
    const apiKey = resolveApiKey(instance.credentialRef)
    if (!apiKey) throw new ModelsStoreError('not_found', `credential '${instance.credentialRef}' has no value`)
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
