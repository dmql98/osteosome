/**
 * 插件清单（S7-3）—— **数据源是 Core，不是这份文件**
 *
 * ## 这里曾经有一张硬编码的 `PLUGINS` 表，现在没有了
 *
 * 它是 S7 之前唯一的插件清单。问题不是「多了一份要维护」，而是
 * **它和 Core 讲的是同一件事却是两份数据**：Core 知道服务真实状态、
 * 依赖是否满足、插件装没装；这张表一概不知道，只会说「我存在」。
 * 于是状态永远只能在前端猜 —— 而前端拿不到猜对的输入。
 *
 * 现在清单走 `GET /api/plugins`（见 `@/core-sdk/usePlugins`），Core 是唯一真源。
 *
 * ## 剩下的都是纯函数
 *
 * `toPluginViews` 把 Core 的快照**摊平成模板好读的形状**。这不是第二份数据 ——
 * 它的每一个字段都来自快照，没有一个是本地决定的。
 * 之所以要摊平：`PluginSnapshot` 是 `{manifest, state, reason, …}` 的嵌套形状，
 * 模板里写 `plugin.manifest.name` 可读性很差。
 *
 * ## `pluginForWidget` 为什么要传列表
 *
 * 以前它读模块内的 `PLUGINS`。现在清单在 store 里，而 store 可能还没 hydrate ——
 * 所以由调用方把列表传进来，**不在这里偷偷读 store**。
 * 读 store 看起来方便，但那会让这个函数在组件外调用时抛错（pinia 未激活），
 * 而 `layout.store.reconcilePlugins` 恰好就在组件外调它。
 */

/** 插件声明的一个命名视图（`ui.views[]`，P3 起由 Core 原样透出） */
export interface PluginUiView {
  id: string
  title: string
  /** 相对 `dist/ui/` 的入口，惯例 `index.html` / `index.html#timeline` */
  entry: string
}

/** Core `GET /api/plugins` 的响应（与 core/src/service-manager/plugin-registry-runtime.ts 对应） */
export interface PluginManifest {
  id: string
  name: string
  version: string
  icon?: string
  description?: string
  author?: string
  license?: string
  services: string[]
  components: string[]
  capabilities?: { name: string; detail?: string }[]
  dependencies?: { pluginId: string; optional?: boolean }[]
  autoStart?: boolean
  /**
   * WebUI 产物（P3）。**缺省 = 纯服务插件**（credentials / reliability 就是），
   * 别把「没有 ui」当成故障。
   */
  ui?: { views: PluginUiView[] }
}

export type PluginState = 'ready' | 'degraded' | 'stopped' | 'failed'

export interface PluginSnapshot {
  manifest: PluginManifest
  installed: boolean
  state: PluginState
  reason: string
  missingDependencies: string[]
  missingOptional: string[]
  unhealthyServices: string[]
  readyServiceCount: number
  serviceStates: Record<string, string | undefined>
}

export type PluginLayerStatus = 'disabled' | 'missing-dir' | 'empty' | 'ok'

export interface PluginListResponse {
  layer: PluginLayerStatus
  pluginsDir: string | null
  installOrder: string[]
  problems: { where: string; reason: string; pluginId?: string }[]
  cycles: string[][]
  plugins: PluginSnapshot[]
}

/** 前端视图模型：给模板用，字段全部派生自 `PluginSnapshot` */
export interface PluginView {
  id: string
  name: string
  /** 没有 icon 就退化成首字，模板里直接当头像用 */
  icon: string
  version: string
  author?: string
  license?: string
  description: string
  capabilities: { name: string; detail?: string }[]
  /**
   * S7 起的**归属声明**：这些 widget id 属于本插件（本地组件）。
   *
   * 与 `views` 并存是过渡期的形态，不是两份真相源：
   * `components` 管「id 归我」（停用时一起藏），`views` 管「这个 id 是一个插件页面」。
   * 本地组件不可能出现在 `views` 里（它连 `dist/ui` 都没有），
   * 所以 `components` 还得留着 —— P5 之后它会逐个归零。
   */
  components: string[]
  /** P3 起的形态：插件自带的页面。Core 伺服在 `/plugins/<id>/ui/<entry>` */
  views: PluginUiView[]
  services: string[]
  dependencies: { pluginId: string; label: string; optional: boolean }[]
  state: PluginState
  reason: string
  installed: boolean
  missingDependencies: string[]
  /** 可选依赖中未满足的 —— 不影响 state，只作展示 */
  missingOptional: string[]
  unhealthyServices: string[]
  readyServiceCount: number
  totalServices: number
  /**
   * 服务 id → 真实状态。`undefined` = 该服务未在跑。
   *
   * 必须带出来：详情窗要能逐个服务显示状态，而 Core 才知道真实状态。
   * 前端若只拿 `state`（插件级聚合结果）就没法回答「哪个服务坏了」。
   */
  serviceStates: Record<string, string | undefined>
  /**
   * P6 起新增：**这是不是应用自带、装了就有的插件**。
   *
   * 判定依据是「Core 会不会自己启它」：`autoStart` 为真、或它排在 `installOrder`
   * 里且状态不是未安装。这条只被「默认布局放哪些视图」用到 ——
   * 见 `widgets/registry.ts` 的 `defaultWidgetIds`。
   *
   * 为什么不用一张写死的名单：名单会过期，而过期的方式很隐蔽
   * （新插件忘了加进名单 → 它的视图默认不出现 → 只有新用户撞上）。
   * 而 `autoStart` 是插件自己声明的、Core 已经拿来做启动决策的事实 ——
   * 前端只是**读同一个事实**，不重新定义一遍「什么算内置」。
   */
  builtin: boolean
}

/** Core 快照 -> 模板视图 */
export function toPluginViews(
  snapshots: readonly PluginSnapshot[],
  installOrder: readonly string[] = [],
): PluginView[] {
  const names = new Map(snapshots.map((p) => [p.manifest.id, p.manifest.name]))
  return snapshots.map((snapshot) => {
    const m = snapshot.manifest
    return {
      id: m.id,
      name: m.name,
      icon: m.icon ?? m.name.slice(0, 1),
      version: m.version,
      author: m.author,
      license: m.license,
      description: m.description ?? '',
      capabilities: m.capabilities ?? [],
      components: m.components ?? [],
      views: m.ui?.views ?? [],
      services: m.services ?? [],
      // 依赖的 label 取对方插件名 —— Core 只给 pluginId（依赖关系是数据，不是文案）
      dependencies: (m.dependencies ?? []).map((dep) => ({
        pluginId: dep.pluginId,
        label: names.get(dep.pluginId) ?? dep.pluginId,
        optional: dep.optional === true,
      })),
      state: snapshot.state,
      reason: snapshot.reason,
      installed: snapshot.installed,
      missingDependencies: snapshot.missingDependencies,
      missingOptional: snapshot.missingOptional,
      unhealthyServices: snapshot.unhealthyServices,
      readyServiceCount: snapshot.readyServiceCount,
      totalServices: m.services?.length ?? 0,
      serviceStates: snapshot.serviceStates ?? {},
      // `autoStart` 是插件自己说的；`installOrder` 是 Core 算的启停序。
      // 两者取「或」：任一条成立就说明它不需要用户另行安装。
      builtin: m.autoStart === true || (installOrder.includes(m.id) && snapshot.installed),
    }
  })
}

/**
 * widget 归属哪个插件。列表由调用方传 —— 见文件头的说明。
 *
 * 两份声明取并集、`views` 优先（见 `PluginView.components` 的注释）：
 * 一个 id 可能是插件的**页面**（`ui.views`），也可能是还在 client 包里的
 * **本地组件**而由 `components[]` 声明归属。两者都要能查到 ——
 * 否则「停用这个插件」会漏藏它的本地组件。
 */
export function pluginForWidgetIn(
  plugins: readonly PluginView[],
  widgetId: string,
): PluginView | undefined {
  return (
    plugins.find((plugin) => plugin.views.some((view) => view.id === widgetId)) ??
    plugins.find((plugin) => plugin.components.includes(widgetId))
  )
}