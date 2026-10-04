/**
 * widget 注册表（P4）—— **本地组件 + 插件视图，两个来源**
 *
 * ## P4 做了什么，没做什么
 *
 * 目标是「组件来源从编译期 glob 改成运行时发现（`/api/plugins` 的 `ui.views`）」。
 * 但此刻**没有任何插件声明 `ui`**（还没有 `ui/` 源码，P5 才搬），
 * 而 10 个内置 widget 还都在 client 包里。所以 P4 做的是把**运行时那条腿装上**，
 * 同时保留本地那条 —— 之后每个插件在搬走自己那份组件的**同一个提交里**删掉本地组件，
 * 窗口里 id 与几何都不会动。
 *
 * ## 为什么 id 不加命名空间
 *
 * 插件视图的 id 就叫 `widget.llm-settings`，和它顶替的那个本地组件**同名**。
 * 这是刻意的：widget id 是 `params.widgets[]` 与 `layout[id]` 的持久化主键，
 * 一旦改名，用户拖好的位置就全丢了（症状是「升级后所有组件回到默认位置」）。
 * 同名 = 零迁移 = 组件在原地换了实现。
 *
 * ## 同名冲突谁赢
 *
 * **插件视图赢，本地组件兜底。** 反过来的话，P5 搬完 UI 也不会生效，
 * 而这种错会一直静默到有人去翻产物目录才发现。
 *
 * 代价是「插件声明了但产物没构建」会画出一个 404 的 iframe —— 所以
 * `PluginWidgetHost` 对加载失败有明确的占位与提示，而不是一块空白。
 */
import { defineAsyncComponent, type Component } from 'vue'
import type { PluginView } from '@/plugins/registry'
import { defineWidget } from './definition'
import { pluginViewSrc, type PluginUiView, type ResolvedWidget, type WidgetDefinition } from './types'

const widgetModules = import.meta.glob<{ default: WidgetDefinition }>('./*/*-widget.vue', { eager: true })
const localWidgets = new Map<string, WidgetDefinition>()

for (const module of Object.values(widgetModules)) {
  const definition = module.default
  if (!definition?.id || !definition.title) throw new Error('widget definition requires id and title')
  if (localWidgets.has(definition.id)) throw new Error(`duplicate widget id: ${definition.id}`)
  localWidgets.set(definition.id, definition)
}

/**
 * 已删除、但用户布局里可能还留着的 widget id（P4）。
 *
 * **为什么需要这张表**：删除一个组件时，光把它的定义删掉，等于让用户的布局
 * 悄悄少一个盒子 —— 而他没做任何操作。要说清「这个组件是被我们删的，
 * 它叫『模型供应商』，你可以把它删掉」，就需要记得它当时叫什么。
 * 未知 id 也画占位，但说的是「未知组件」，那对用户没有价值。
 *
 * `replacedBy` 指向接替它的 id（若有）：占位上可以直接给出「用 X 替代」。
 * 这是**单向**的：不要拿它做「老 id 自动升级成新 id」——
 * 那会让用户保存的布局在**他没要求**的情况下被改写。
 */
export const RETIRED_WIDGETS: Record<string, { title: string; replacedBy?: string }> = {
  // P4：模型供应商独立 widget 被合并进模型设置卡片（连接/断开/删除都在那里了）
  'widget.llm-providers': { title: '模型供应商', replacedBy: 'widget.llm-settings' },
}

export { defineWidget }
export type { PluginUiView, ResolvedWidget, WidgetDefinition }

/** 某个插件声明的视图列表（`ui` 缺省即没有 UI —— 纯服务插件合法地不声明） */
export function pluginViews(plugin: PluginView): PluginUiView[] {
  return plugin.views
}

/** 本地组件注册表（不含插件视图）。取本地定义用 */
export function getWidget(id: string): WidgetDefinition | undefined {
  return localWidgets.get(id)
}

export function listWidgets(): WidgetDefinition[] {
  return [...localWidgets.values()]
}

export function widgetComponents(): Record<string, Component> {
  return Object.fromEntries(listWidgets().map((widget) => [widget.id, defineAsyncComponent(widget.component)]))
}

/**
 * 默认布局里放哪些 widget —— **只放本地组件**。
 *
 * 默认布局是「打开即是三盒对话」的引导，所以它必须是**确定的**：
 * 如果把插件视图也灌进来，一个 UI 产物还没构建的新装环境会得到一屏 404 框
 * （插件视图是用户在插件详情窗里**显式**加入的，不是默认送的）。
 */
export function defaultWidgetIds(): string[] {
  return listWidgets().map((widget) => widget.id)
}

/**
 * 把 widget id 解析成「它到底是什么」。
 *
 * 列表由调用方传（`PluginView[]`）—— 与 `pluginForWidgetIn` 同一条规矩：
 * **不在这里偷偷读 store**，否则组件外调用会在 pinia 未激活时抛错。
 *
 * 判定顺序（这个顺序是 P4 的核心语义，别随手调换）：
 * 1. **插件视图**（`ui.views[].id`）→ iframe：迁移目标形态
 * 2. **本地组件** → local
 * 3. **已退役**（`RETIRED_WIDGETS`）→ 占位，说得清它叫什么、为什么没了
 * 4. **真的不认识** → 也是占位，但说「未知组件」
 *
 * ## 归属 ≠ 形态，这一步最容易写错
 *
 * 一个 id 可能**同时**满足「某个插件在 `components[]` 里声明了它」
 * 与「它在本地注册表里」。这时它是 `local`，不是 iframe ——
 * `components[]` 只声明**归属**（谁停用时该把它一起藏起来），不声明形态。
 * 早期版本在这里混淆过一次，结果是 10 个内置 widget 全部变成 404 的 iframe。
 *
 * 停用的插件**不算 missing**：它的 id 仍然解析得出来，只是
 * `pluginForWidget` 会告诉调用方「这个 id 属于一个已停用的插件」——
 * 由渲染层决定隐藏（沿用既有语义：停用仅隐藏，重新启用自动恢复）。
 */
export function resolveWidget(id: string, plugins: readonly PluginView[] = []): ResolvedWidget {
  const view = findDeclaredView(id, plugins)
  if (view) {
    return {
      kind: 'iframe',
      id,
      title: view.title,
      pluginId: view.pluginId,
      src: pluginViewSrc(view.pluginId, view.entry),
    }
  }
  const local = localWidgets.get(id)
  if (local) {
    // 这里**必须**包一层 `defineAsyncComponent`：本地组件的 definition 里存的是
    // 一个 loader（`() => import(...)`），模板 `:is` 拿到裸函数时 Vue 会把它当
    // 函数式组件调用，拿到 Promise 当渲染结果 —— 盒子画出来，里面是空的。
    // 之前是 `widgetComponents()` 在做这一步，PanelContainer 改用 resolveWidget 后
    // 必须在这里做，否则「静默空盒」而没有任何报错。
    return { kind: 'local', id, title: local.title, component: defineAsyncComponent(local.component) }
  }
  const retired = RETIRED_WIDGETS[id]
  if (retired) return { kind: 'missing', id, title: retired.title, reason: 'removed' }
  return { kind: 'missing', id, title: id, reason: 'unknown' }
}

interface FoundView extends PluginUiView {
  pluginId: string
}

/** 只认 `ui.views[]` —— 它才声明「这个 widget 是一个插件页面」 */
function findDeclaredView(id: string, plugins: readonly PluginView[]): FoundView | undefined {
  for (const plugin of plugins) {
    for (const view of plugin.views) {
      if (view.id === id) return { ...view, pluginId: plugin.id }
    }
  }
  return undefined
}

/**
 * 某个插件可加入窗口的全部 widget id。
 *
 * `ui.views` 的 id **加上** `components[]` 里的 id：后者是本地组件的归属声明
 * （插件停用时该把它一起藏起来），而本地组件照样是可以加入窗口的。
 * 两份去重后一起给出去 —— 用户在插件详情窗里看到的「组件」列表，
 * 不该因为这个组件恰好还没搬走就不见了。
 */
export function addableWidgetIds(plugin: PluginView): string[] {
  const ids = new Set<string>(plugin.views.map((view) => view.id))
  for (const id of plugin.components) ids.add(id)
  return [...ids]
}