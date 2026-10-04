/**
 * 服务状态表 —— 转发到 `@osteosome/core-client`（P6）。
 *
 * 原来是 client 里的一个 **pinia store**。现在改成包里的一张 `reactive` 表，
 * 由宿主与所有插件 UI 共用。
 *
 * ## 去掉 pinia 的理由（不是「pinia 不好」，是这里用不上）
 *
 * · 这张表 51 行、只被 `useServiceStatus` 用；
 * · pinia 的价值在 devtools / 跨 store 依赖 / 插件化 store —— 这里一个都没有；
 * · 而它<b>要收</b>的代价是每个插件 UI 都得 `createPinia()` 并挂上，
 *   忘了就在 setup 里抛错。插件 UI 是独立入口，比宿主更容易漏这一步。
 *
 * API 形状刻意保持一致（`services` / `readyCount` / `totalCount` /
 * `apply` / `setStatus` / `clear`），所以 client 的调用点一行都不用改。
 */
export {
  serviceStatus as useServiceStore,
  serviceStatus,
  type ServiceLifecycle,
  type ServiceStatusEntry,
} from '@osteosome/core-client'