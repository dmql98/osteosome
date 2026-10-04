/**
 * 数据目录约定（P1a §3.1，插件化后修订）：
 *
 * ```
 * <dataDir>/
 * ├── core/                  ← Core 自己的数据（偏好 / 凭证；Core 解析它们）
 * └── plugin/<pluginId>/     ← 插件的用户数据；**里面有什么由插件自己定**
 *     └── sessions/            ← 服务的子目录（例：session 服务写这里）
 * ```
 *
 * ## 为什么是「插件级」而不是「服务级」
 *
 * 原来是 `services/<serviceId>/`（每个服务一个目录）。插件化之后数据归**插件** ——
 * 一个插件的 UI 与它的服务要看到同一份东西（llm-provider 的密钥就是一个），按服务切
 * 就得多一份「哪个服务属于哪个插件」的映射才能对上。
 *
 * ## 一个插件有多个服务怎么办
 *
 * 它们**共享**同一个插件数据根，各自在里面加自己的子目录 —— 今天只有 session 服务落盘，
 * 写 `${dataDir}/sessions/`。真出现两个服务写同名文件的情况，再在插件内部分服务子目录；
 * 现在分是提前设计。
 *
 * ## 目录约定只有这一条
 *
 * **Core 不解析插件数据的内容与格式**：它只负责算出这个路径并交给服务
 * （见 `core/src/service-manager/manager.ts` 的 `serviceDataDirs`）。
 */
import { join, sep } from 'node:path'

/**
 * `${dataDir}/plugin/<pluginId>/`（带结尾分隔符，便于拼接子路径）
 *
 * `pluginId` 用 plugin.json 的 `id`，**不是目录名** —— 两者可以不一致
 * （`scanPlugins` 会就这一点告警，但以 id 为准）。
 */
export function pluginDataDir(dataDir: string, pluginId: string): string {
  return `${join(dataDir, 'plugin', pluginId)}${sep}`
}

/**
 * `${dataDir}/core/` —— Core 自己的数据（偏好 / 凭证）。
 *
 * 与 `pluginDataDir` 并列而非取代：Core 仍然解析自己的那几个键
 * （`plugins.uninstalled` / `plugins.enabled` / `ui.theme`），所以它需要一个专属位置，
 * 免得跟插件的私有文件混在一个命名空间里。
 */
export function coreDataDir(dataDir: string): string {
  return `${join(dataDir, 'core')}${sep}`
}

/** 预校验：服务标识只允许小写字母数字与连字符（目录名安全） */
const SAFE_ID = /^[a-z0-9-]+$/

export function isValidServiceId(id: string): boolean {
  return SAFE_ID.test(id)
}

/** 预校验：插件 id 同理（会拼进数据目录路径） */
export function isValidPluginId(id: string): boolean {
  return SAFE_ID.test(id)
}