/**
 * 厂商预设表（S1）—— 「加一家厂商 = 加一行」的单一真源。
 *
 * > **P5 起，「表」是 `plugins/models/catalog.json`，本文件是它的契约。**
 *
 * ## 为什么是数据不是代码
 *
 * 此前：`llm-provider-deepseek` 与 `llm-provider-openrouter` 的 `provider.ts` 就是
 * `llm-provider-openai` 的**副本**，只差 `BASE_URL` 与 `STATIC_MODELS`。也就是说
 * 「支持 N 家 openai 兼容厂商」的真正成本不是代码，而是**每家一个进程 + 一份副本**
 * （这两个副本已在 S2 删除）。
 *
 * 本表把那份成本降成一行：所有厂商共用**一个** provider 进程，按本表在进程内建多个
 * 「实例」（各自 baseUrl / 凭证引用 / 默认模型 / 静态目录），逐个注册到 `llm` 主位。
 *
 * ## 判定「这家能不能用」
 *
 * `credentialEnv` 非空 → 该 env 有值才注册；为空（本地端点 ollama / vllm / lm-studio）→ 总是注册。
 * 不注册的厂商不会出现在前端下拉里，指定它发问会得到 `unsupported_provider` ——
 * 这就是「存在性由配置决定」，语义上等价于「没装」。
 *
 * ## env 覆盖（测试与自建端点的主力入口）
 *
 * | 目的 | env |
 * |---|---|
 * | 改某家的端点 | `<ID_UPPER>_BASE_URL`，如 `DEEPSEEK_BASE_URL` |
 * | 改某家的默认模型 | `<ID_UPPER>_MODEL`，如 `DEEPSEEK_MODEL` |
 * | 附加 header（全局） | `OPENAI_EXTRA_HEADERS`（JSON） |
 *
 * 优先级：**env 覆盖 > 预设值**。这让集成冒烟可以用假上游指任意厂商，无需改代码。
 */

/**
 * 厂商预设的**契约**（不是数据）。
 *
 * ## 数据搬走了（P5）
 *
 * 12 家预设原来是一份编译期常量 `VENDOR_PRESETS`。现在它在
 * `plugins/models/catalog.json` —— 插件自带数据，UI 与 provider 服务读同一份文件。
 * 搬走之后这里只剩**类型、wire 契约与 env 覆盖规则**。
 *
 * ## 为什么要搬
 *
 * · 「加一家厂商」应该只改一个数据文件，不用改 shared 的代码、不用重编译所有包；
 * · 数据归插件 —— 不装 models 插件就不该被它的厂商表牵扯；
 * · **UI 与服务端读同一份文件**，于是「界面上有的厂商，服务一定认」不再靠两边手工同步。
 *
 * 仍然留在 shared 的是**规则**（env 覆盖优先级、wire → 服务 id 的映射）——
 * 规则是跨进程契约，数据不是。
 */

/** 一家厂商的预设 */
export interface VendorPreset {
  /** provider id（注册到主位路由表的名字，如 'deepseek'） */
  id: string
  /** 展示名 */
  label: string
  /** 上游根（含 `/v1`，不含 `/chat/completions`）；可用 `<ID_UPPER>_BASE_URL` 覆盖 */
  baseUrl: string
  /**
   * **wire 实现 id —— 由哪个 provider 进程来实现这家。**
   *
   * 这不是「协议名」而是**跨进程契约**：约定 wire `X` 由服务 `llm-provider-X` 实现
   * （见 {@link providerServiceIdForWire}）。
   *
   * - `WIRE_OPENAI`：请求体 / SSE 全是 openai 兼容形状 → 12 家共用 `llm-provider-openai`
   *   一个进程，**加一家 = 加一行**
   * - 将来 wire 完全不同的（如请求体结构、鉴权头、连非 SSE 传输都不同的那家）：
   *   新增一个 wire id + 新建 `llm-provider-<wire>` 进程 + 独立插件，**`llm` 主位与前端零改动**
   *
   * 为什么不把新 wire 也塞进本表由本进程处理：那会让本表从「本进程能服务的清单」变成
   * 「全系统 wire 的声明」，而一个进程**兑现不了自己声明不了的东西** —— 表现是注册出一个
   * 声称支持、实际会发错请求体的假 provider。`shared/tests/vendor-wires.test.ts`
   * 断言「表里出现的每个 wire 都有对应服务目录」，缺进程就在 CI 挂掉，不留到运行时静默。
   */
  api: string
  /** 凭证所在 env 名（`credentialRef = env:<此值>`）；空串 = 免凭证（本地端点） */
  credentialEnv: string
  /** 默认模型；可用 `<ID_UPPER>_MODEL` 覆盖 */
  defaultModel: string
  /** 静态兜底目录（上游 `/models` 拉不到时用，前端会挂「静态列表」角标） */
  models: string[]
  /** 备注（设置窗展示） */
  note?: string
}

/** openai 兼容 wire（当前唯一内置 wire，由 `llm-provider-openai` 实现） */
export const WIRE_OPENAI = 'openai'

/** wire id → 实现它的服务 id（约定：wire `X` → 服务 `llm-provider-X`） */
export function providerServiceIdForWire(wire: string): string {
  return `llm-provider-${wire}`
}

/** 本进程只服务属于某个 wire 的预设（provider 进程启动时按自己的 wire 过滤）。
 *
 *  `presets` **没有默认值**了 —— 数据搬去了 `plugins/models/catalog.json`（P5），
 *  这里只剩契约。留一个默认表等于把数据又抄回 shared 一份。
 */
export function presetsForWire(wire: string, presets: readonly VendorPreset[]): VendorPreset[] {
  return presets.filter((p) => p.api === wire)
}

/** 预设表声明过的全部 wire（去重、有序） */
export function declaredWires(presets: readonly VendorPreset[]): string[] {
  return [...new Set(presets.map((p) => p.api))].sort()
}

/**
 * 解析并校验 `catalog.json`（P5）。
 *
 * ## 为什么校验器住在 shared
 *
 * 这份文件现在有**两个读者**：models 的 provider 服务（`plugins.readFile`）与它的 UI
 * （`GET /plugins/models/ui/catalog.json`）。两份校验逻辑必然漂移 ——
 * 漂移的症状是「UI 上出现了这家厂商，但服务不认它」，而排障要跨两个进程。
 * 所以校验器与**类型**放一起：谁读都跑同一条规则。
 *
 * ## 逐条报，不整份拒
 *
 * 一家厂商写错 `baseUrl` 不该让其余 11 家一起消失。返回 `{ vendors, errors }`：
 * 好的进 `vendors`，坏的逐条进 `errors`。调用方决定怎么呈现错误
 * （服务侧倾向于**照常启动**并把错误打进日志 —— UI 里少一家比整个 provider 起不来好）。
 */
export function parseVendorCatalog(raw: unknown): {
  vendors: VendorPreset[]
  errors: string[]
} {
  const errors: string[] = []
  const vendors: VendorPreset[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { vendors, errors: ['catalog is not an object'] }
  }
  const list = (raw as { vendors?: unknown }).vendors
  if (!Array.isArray(list)) {
    return { vendors, errors: ['catalog.vendors is not an array'] }
  }

  const seen = new Set<string>()
  list.forEach((item, index) => {
    const at = `vendors[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} is not an object`)
      return
    }
    const v = item as Record<string, unknown>
    const bad = (why: string): void => {
      errors.push(`${at} (${String(v.id ?? '?')}): ${why}`)
    }
    for (const key of ['id', 'label', 'baseUrl', 'api', 'defaultModel'] as const) {
      if (typeof v[key] !== 'string') {
        bad(`${key} must be a string`)
        return
      }
    }
    // `credentialEnv` 允许空串（本地端点免凭证），但必须是字符串 ——
    // 「没写」与「写了但不是字符串」是两件事，后者是数据错误。
    if (typeof v.credentialEnv !== 'string') {
      bad('credentialEnv must be a string (use "" for no credential)')
      return
    }
    if (!Array.isArray(v.models) || v.models.some((m) => typeof m !== 'string')) {
      bad('models must be an array of strings')
      return
    }
    if (v.note !== undefined && typeof v.note !== 'string') {
      bad('note must be a string when present')
      return
    }
    const id = v.id as string
    if (!id) {
      bad('id must not be empty')
      return
    }
    if (seen.has(id)) {
      // 重复 id 会被后面的静默覆盖 —— 用户会看到「设了没生效」
      errors.push(`${at} (${id}): duplicate vendor id`)
      return
    }
    seen.add(id)
    vendors.push({
      id,
      label: v.label as string,
      baseUrl: v.baseUrl as string,
      api: v.api as string,
      credentialEnv: v.credentialEnv as string,
      defaultModel: v.defaultModel as string,
      models: v.models as string[],
      ...(typeof v.note === 'string' ? { note: v.note } : {}),
    })
  })

  return { vendors, errors }
}

/** env 覆盖用的后缀：`deepseek` → `DEEPSEEK`（含 `-` → `_`） */
export function vendorEnvSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
}

/** 该厂商的 baseURL env 名，如 `DEEPSEEK_BASE_URL` */
export function vendorBaseUrlEnvName(id: string): string {
  return `${vendorEnvSuffix(id)}_BASE_URL`
}

/** 该厂商的默认模型 env 名，如 `DEEPSEEK_MODEL` */
export function vendorModelEnvName(id: string): string {
  return `${vendorEnvSuffix(id)}_MODEL`
}

/** 去尾部斜杠（`…/v1/` → `…/v1`） */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** env 覆盖优先的 baseURL 解析；env 缺省或空白 → 用预设值 */
export function resolveVendorBaseUrl(vendor: VendorPreset, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[vendorBaseUrlEnvName(vendor.id)]?.trim()
  return trimTrailingSlash(override && override.length > 0 ? override : vendor.baseUrl)
}

/** env 覆盖优先的默认模型解析；env 缺省 → 用预设值 */
export function resolveVendorModel(vendor: VendorPreset, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[vendorModelEnvName(vendor.id)]?.trim()
  return override && override.length > 0 ? override : vendor.defaultModel
}

/** 凭证引用（`env:<NAME>`）；免凭证厂商返回空串 */
export function vendorCredentialRef(vendor: VendorPreset): string {
  return vendor.credentialEnv ? `env:${vendor.credentialEnv}` : ''
}

/** 该厂商是否「已配置」：免凭证 → 恒 true；否则看 env 里有值 */
export function hasVendorCredential(vendor: VendorPreset, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!vendor.credentialEnv) return true
  const value = env[vendor.credentialEnv]
  return typeof value === 'string' && value.trim().length > 0
}
