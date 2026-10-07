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
  /** 请求体 wire；与本进程服务的那一套不同则跳过并告警 */
  api?: string
}

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
  return { connectedVendors: [], vendorOverrides: [], enabledModels: [] }
}