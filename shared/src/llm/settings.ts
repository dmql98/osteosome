/**
 * models 插件的**用户数据形状**（接入清单 + 凭证）—— 单一真相源。
 *
 * ## 为什么这些类型住在 shared 而不是插件里
 *
 * 三方都要读它，而三方分属三个进程：
 * - **provider 服务**（`llm-provider-openai`）—— 数据的**所有者**，读写 `userData/plugin/models/`
 * - **models 的 UI**（模型接入面板）—— 经总线读订阅 + 发命令
 * - **会话输入框**（chat-workbench 插件）—— 读 `enabledModels` 过滤模型下拉
 *
 * 形状写在插件里的话，UI 就得从 `plugins/models/...` 深路径 import，那条路会把
 * 插件目录结构变成编译期依赖（而插件是**可换的**：同 wire 的另一个实现也该能用这份形状）。
 * 所以：形状在 shared，**数据**在插件自己的目录。
 *
 * ## 数据在哪
 *
 * ```
 * <dataDir>/plugin/models/
 * ├── preferences.json   ← ModelsPrefs（接入清单 / 自填端点 / 逐模型开关）
 * └── credentials.json   ← 密钥（明文只在本文件与 owner 进程内存里）
 * ```
 *
 * 这与 Core 自己的 `<dataDir>/core/preferences.json`（布局 / 主题 / 插件启停）是**并列**关系，
 * 不是被它取代 —— 见 `docs/插件化架构优化.html` §4 的三层布局。
 */

/** 用户自填 / 改写的 OpenAI 兼容端点 */
export interface EndpointOverride {
  /** 端点 id（与预设 id 同名即「改写那一家」，否则是新增端点） */
  id: string
  label?: string
  baseUrl: string
  defaultModel?: string
  /** `''` = 显式免凭证；**缺省 = 要凭证**（owner 按 id 去 env / 自己的凭证文件找） */
  credentialRef?: string
  /**
   * 该端点的模型清单 —— 用户在「获取模型列表」里**采纳进配置**的那份。
   *
   * 它不是缓存，是**静态兜底**：owner 把它原样喂给实例的 `staticModels`
   * （`instances.ts` 的 `instanceFromOverride`），于是
   * - 进程重启后（探测结果只在内存里，重启即空）模型下拉里仍有这份清单；
   * - 端点一时连不上、或上游没实现 `/models` 时，降级用的是它而不是空列表。
   *
   * 缺省 = 没有静态清单，模型只来自实时探测。
   */
  models?: string[]
  /** 请求体 wire；与本进程服务的那一套不同则跳过并告警 */
  api?: string
}

/**
 * 模型能力（用户按模型声明的那几项）。
 *
 * ## 为什么不是 `models: { id, ... }[]`
 *
 * 模型清单的**形状**是跨进程协议：`llm.models.list.result.models` 是 `string[]`，
 * 会话输入框、`enabledModels`（`provider::model`）、provider 的 `staticModels`
 * 都以「模型名」为准。把清单本身改成对象数组要同时改协议、provider、输入框三处，
 * 而收益只是「多存几个字段」。
 *
 * 所以能力单独一张表，键与 `enabledModels` 同构（`${providerId}::${model}`）：
 * **清单是清单，能力是能力**，缺省（没有这一条）= 全用默认。
 *
 * ## 现阶段谁真的读它
 *
 * - `reasoningEfforts` —— 会话输入框据此过滤「思考：关/低/中/高」，
 *   不再给一个模型不支持的档位（provider 那边只是把它发成 `reasoning_effort`）；
 * - `contextWindow` / `maxTokens` / `input` —— **只记录与展示**：
 *   ost 目前没有上下文裁剪，也还不支持图片输入。留在这里是因为它们是
 *   「这个模型是什么」的事实，配一次就能被后续能力接上，而不是等有了消费方再让用户重填。
 */
export interface ModelProfile {
  /** 上下文窗口（token）。缺省 = 用上游/模型默认 */
  contextWindow?: number
  /** 最大输出 token。缺省 = 用上游/模型默认 */
  maxTokens?: number
  /** 输入模态。缺省 = 只有文本（与「不配这一项」的现状一致） */
  input?: ModelInput[]
  /**
   * 该模型支持的思考档位（`off` / `low` / `medium` / `high`）。
   * 缺省或空数组 = 不限制（四档全给）。
   */
  reasoningEfforts?: string[]
}

/** 模型输入模态 */
export type ModelInput = 'text' | 'image'

/** 模型能力的表键：`${providerId}::${model}`（与 `enabledModels` 同一个拼法） */
export type ModelProfileKey = string

/** models 插件的用户设置 = `preferences.json` 的内容 */
export interface ModelsPrefs {
  /**
   * 用户点过「连接」的厂商 id。
   *
   * **空 = 一家都没接** —— 12 家预设默认全在「未连接的预设」里，点连接才写进来。
   * 它是**意图**声明，不是可用性判据：能不能真发出去由凭证与端点决定（见 `llm.provider.registered`）。
   */
  connectedVendors: string[]
  /** 自填端点 / 对预设的改写 */
  vendorOverrides: EndpointOverride[]
  /**
   * 已禁用的模型，元素是 `${providerId}::${model}`。
   *
   * **空数组 = 全启用** —— 默认态，老文件一个字没写也照常工作。
   * 反向存「已启用」就得先知道全集，而全集来自探测，探测前是空的。
   */
  enabledModels: string[]
  /**
   * 模型能力表：`${providerId}::${model}` → {@link ModelProfile}。
   *
   * **没有这个键 = 这个模型全用默认**，所以老偏好文件一个字没写也照常工作；
   * 某条里的某个字段缺省，同样表示「这一项用默认」。
   *
   * 与 `enabledModels` 的键同构，是为了让「这个模型开不开 / 它有什么能力」
   * 在设置页与输入框两侧都能用同一个拼法取到。
   */
  modelProfiles: Record<ModelProfileKey, ModelProfile>
}

export type CredentialKind = 'apiKey'

/**
 * 凭证的**掩码**形态 —— 前端与事件唯一可见的形态（`sk-abc…xyz`）。
 *
 * ⚠️ 安全红线：明文 `value` **永不出 owner 进程**（不进事件 / SSE / 前端 / 日志）。
 * 它只存在 `userData/plugin/models/credentials.json` 与 owner 进程内存里。
 */
export interface MaskedCredential {
  id: string
  name: string
  /** 归属厂商（如 `deepseek` / `openai`）—— owner 据此把厂商与密钥对上 */
  provider: string
  kind: CredentialKind
  masked: string
  createdAt: string
  updatedAt: string
}

/** 缺省值：新文件与容错读取都用它（空接入清单 = 全启用，语义与文件缺失一致） */
export function emptyModelsPrefs(): ModelsPrefs {
  return { connectedVendors: [], vendorOverrides: [], enabledModels: [], modelProfiles: {} }
}

/**
 * 模型能力的表键 —— **唯一的拼法**（`${providerId}::${model}`）。
 *
 * 用 `::` 而不是 `:`，是因为模型名里本来就有冒号（`qwen2.5:7b`）；
 * 这与 `enabledModels` 是同一条约定，两处各写一遍迟早会写岔。
 */
export function modelProfileKey(providerId: string, model: string): ModelProfileKey {
  return `${providerId}::${model}`
}

/** 取某个模型的能力（没配 = `{}`，免得调用方到处 `?? {}`） */
export function modelProfileOf(
  profiles: Record<ModelProfileKey, ModelProfile> | undefined,
  providerId: string,
  model: string,
): ModelProfile {
  return profiles?.[modelProfileKey(providerId, model)] ?? {}
}

/** 该模型支持的思考档位；**空 = 不限制**（返回 `undefined`，调用方按「全给」处理） */
export function reasoningEffortsOf(
  profiles: Record<ModelProfileKey, ModelProfile> | undefined,
  providerId: string,
  model: string,
): string[] | undefined {
  const declared = modelProfileOf(profiles, providerId, model).reasoningEfforts
  return declared && declared.length > 0 ? declared : undefined
}