/**
 * chat-workbench 插件清单 —— 等价 osteosome `plugins/chat-workbench/plugin.json`。
 *
 * ## 与 osteosome 的对应关系
 *
 * 真实清单里 `ui.views[]` 声明的是**入口 HTML**（`index.html#chat-timeline`），
 * 宿主用 iframe 装载。本 Demo 是纯前端参考，不做 iframe，
 * 所以这里声明的是**组件**而不是入口 —— 但字段语义一致：
 *
 * | 字段 | osteosome | 本 Demo |
 * |---|---|---|
 * | `id` | `widget.chat-timeline` | 同 |
 * | `title` | 展示名 | 同 |
 * | `entry` | `index.html#chat-timeline` | 组件引用（`components[].name`） |
 *
 * ## widget id 是持久化主键
 *
 * 它是 `params.widgets[]` 与布局里的主键，**一旦改名，用户拖好的位置就全丢了**。
 * 所以 id 与 osteosome 保持完全一致，将来把这份清单搬过去不用改 id。
 */
;(function (global) {
  'use strict'

  const C = global.OST.components
  const registry = global.OST.registry

  /**
   * 插件声明的视图。
   *
   * 注意：真实 osteosome 里这些是 iframe 视图，`resolveWidget` 返回 `kind:'iframe'`；
   * 这里注册为本地组件，于是返回 `kind:'local'`。
   * **判定顺序、id 命名、title 语义三者一致**，迁回去只需换注册方式。
   */
  const VIEWS = [
    { id: 'widget.session-list', title: '对话列表', pluginId: 'chat-workbench', entry: 'index.html#session-list', component: C.SessionListView },
    { id: 'widget.chat-timeline', title: '对话流', pluginId: 'chat-workbench', entry: 'index.html#chat-timeline', component: C.ChatTimeline },
    { id: 'widget.chat-composer', title: '输入框', pluginId: 'chat-workbench', entry: 'index.html#chat-composer', component: C.ChatComposerView },
    { id: 'widget.session-workspace', title: '检查器', pluginId: 'chat-workbench', entry: 'index.html#session-workspace', component: C.SessionWorkspaceView },
  ]

  // 注册为本地 widget（真实实现里这一步由 Core 扫盘 plugin.json 完成）
  for (const v of VIEWS) {
    registry.defineWidget(v.id, v.title, v.component)
  }

  global.OST = global.OST || {}
  global.OST.plugin = { id: 'chat-workbench', name: '对话工作台', version: '1.0.0', views: VIEWS }
})(window)
