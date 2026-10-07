/**
 * `@osteosome/core-client` —— **Core 接口的客户端**（P6 新增）
 *
 * ## 它是什么
 *
 * 一组「通过 Core 的 HTTP / SSE 通道与后端说话」的 composable 与单例：
 * 发命令、读写偏好、订阅事件、拉服务状态、查模型目录……
 *
 * ## 为什么要抽出来（这是 P5 留下的一个真实的坑）
 *
 * P5 把模型设置搬进 `plugins/models/ui/` 时，我**复制**了 client 里的 5 个文件过去 ——
 * 逐字节相同。迁第二个插件 UI 就会变成三份。
 *
 * 复制 `catalog.json`（数据）还能靠「一份被编写的文件 + 构建复制」兜住；
 * 复制**逻辑**没有这种兜底：改了一边，另一边静默保持旧行为。症状是
 * 「插件界面的 SSE 断了，宿主的好好的」—— 而 SSE 断线的样子是「什么都不发生了」，
 * 排障时几乎没人会想到去看「这个文件是不是有两份」。
 *
 * 抽成包之后：源码一份，**产物里每插件仍有一份 bundle**（vite 会把它打进每个插件）。
 * 那不是问题 —— 「同一份代码被多处打包」是正常的；问题在「同一份源码被复制」。
 *
 * ## 依赖边界（这个包刻意只有 vue）
 *
 * 没有任何 store、没有 pinia、没有 router、没有 client 的组件。
 * 凡是依赖 client 内部状态的东西（`usePlugins` 读 plugin.store）都**不在这里**。
 * 这条边界是它能被插件直接 import 的前提。
 *
 * ## 同源假设
 *
 * 所有请求都打相对路径（`/api/command`、`/events`）。插件 UI 跑在 Core 伺服下的
 * 同源 iframe 里，所以那些绝对 URL 一行都不用改 —— 这是 P5 最大的便宜。
 */
export {
  sse,
  SseClient,
  type SseHandler,
  type SseState,
  type SseClientOptions,
} from './sse'
export { useCommand } from './useCommand'
export { usePreferences, type Preferences } from './usePreferences'
export { useEventBus } from './useEventBus'
export { useTheme, initTheme, DEFAULT_THEME, type Theme } from './useTheme'
export { useServiceStatus } from './useServiceStatus'
export {
  serviceStatus,
  type ServiceLifecycle,
  type ServiceStatusEntry,
} from './serviceStatus'

// llm 域的 Core 客户端。虽然不是「通用」的，但它们读的也是 Core 的 topic
// （`llm.models.list` / `llm.provider.registered`），按本包的定义就该在这里。
// 等 chat-composer 迁进 chat-workbench 插件之后，它们可以整体搬回插件里 —— 那时
// 宿主与插件都在插件内，就不需要跨边界共享了。
export { useLlmProviders, type LlmProviderEntry } from './useLlmProviders'
export { useEndpointProbe, type ProbeResult } from './useEndpointProbe'
export { useModelCatalog, type ModelCatalogEntry } from './useModelCatalog'
export { useModelsPrefs, useModelCredentials, useEnabledModels } from './useModelsPrefs'