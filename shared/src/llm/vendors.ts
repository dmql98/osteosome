/**
 * 厂商预设表（S1）—— 「加一家厂商 = 加一行」的单一真源。
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

/** 本进程只服务属于某个 wire 的预设（provider 进程启动时按自己的 wire 过滤） */
export function presetsForWire(wire: string, presets: readonly VendorPreset[] = VENDOR_PRESETS): VendorPreset[] {
  return presets.filter((p) => p.api === wire)
}

/** 预设表声明过的全部 wire（去重、有序） */
export function declaredWires(presets: readonly VendorPreset[] = VENDOR_PRESETS): string[] {
  return [...new Set(presets.map((p) => p.api))].sort()
}

/**
 * 内置预设表。
 *
 * ⚠️ baseUrl 为**编写时的公开端点**，使用前请自行核对厂商文档（端点会变）。
 * 任何一家都可以用 `<ID_UPPER>_BASE_URL` 覆盖，或在设置窗里加「自定义端点」。
 */
export const VENDOR_PRESETS: readonly VendorPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: WIRE_OPENAI,
    credentialEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'deepseek-reasoner 恒思考，不接受 reasoning_effort',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash'],
    note: '可经此调用 claude / gemini 等非 openai 原生模型',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'SILICONFLOW_API_KEY',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'XAI_API_KEY',
    defaultModel: 'grok-2-latest',
    models: ['grok-2-latest'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    api: WIRE_OPENAI,
    credentialEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-large-latest'],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: WIRE_OPENAI,
    credentialEnv: '',
    defaultModel: 'qwen2.5:7b',
    models: [],
    note: '本地端点，免凭证',
  },
  {
    id: 'vllm',
    label: 'vLLM（本地）',
    baseUrl: 'http://127.0.0.1:8000/v1',
    api: WIRE_OPENAI,
    credentialEnv: '',
    defaultModel: '',
    models: [],
    note: '本地端点，免凭证；模型名取决于你启了什么',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    api: WIRE_OPENAI,
    credentialEnv: '',
    defaultModel: '',
    models: [],
    note: '本地端点，免凭证',
  },
]

/** provider id → 预设（找不到返回 undefined） */
export function findVendorPreset(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find((v) => v.id === id)
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
