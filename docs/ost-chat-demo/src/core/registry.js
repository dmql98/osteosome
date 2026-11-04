/**
 * Widget 注册表 —— 对应 osteosome `client/src/widgets/registry.ts`。
 *
 * ## 这里面有什么
 *
 * osteosome 的 widget 有三种形态：
 *
 *   local   —— 宿主本地组件（`<component :is>` 直接渲染）
 *   iframe  —— 插件声明的视图（`ui.views[]`，由 PluginWidgetHost 装载）
 *   missing —— 未知或已退役（占位说明为什么没有）
 *
 * 本 Demo 是**纯前端参考**，只做 local 形态；
 * 但判定顺序与三态结构照旧保留 —— 迁回 osteosome 时只需加回 iframe 分支。
 *
 * ## 判定顺序不能调换（osteosome P4 的核心语义）
 *
 * 插件声明的 view 优先于本地组件 —— 同名时插件版本是更新的那个。
 *
 * ## 为什么是纯函数而不是 store
 *
 * 与 `client/src/plugins/registry.ts` 同一条纪律：
 * 「不在这里偷偷读 store」。列表由调用方传进来 ——
 * 读 store 看起来方便，但那会让这个函数在组件外调用时抛错。
 */
;(function (global) {
  'use strict'

  /** @type {Map<string, {id:string,title:string,component:unknown}>} */
  const localWidgets = new Map()

  /** 已退役的 widget —— 与 osteosome 的 RETIRED_WIDGETS 同构 */
  const RETIRED_WIDGETS = {
    'widget.chat-pane': { title: '旧对话面板', replacedBy: 'widget.chat-timeline' },
  }

  /**
   * 注册一个本地 widget。
   * @param {string} id 形如 `widget.session-list`
   * @param {string} title 展示名
   * @param {unknown} component Vue 组件
   */
  function defineWidget(id, title, component) {
    localWidgets.set(id, { id, title, component })
  }

  /**
   * 解析 widget id → 具体形态。
   *
   * ## 判定顺序（osteosome P4 的核心语义，不能调换）
   *
   * 1. **本地注册优先** —— 宿主自己提供的实现
   * 2. 插件声明的 view —— iframe 形态
   * 3. 已退役 → missing(removed)
   * 4. 都不认识 → missing(unknown)
   *
   * ## 与 osteosome 的差别（一处，但要说清）
   *
   * osteosome 里本地组件表在 P6 之后**已被清空**（组件全迁进插件），
   * 所以「插件 view 优先」与「本地优先」在效果上等价 ——
   * 差别只在**同名时谁生效**。
   *
   * 本 Demo 的插件清单同时做了两件事：声明 `ui.views[]`（真实语义）
   * 与注册本地组件（纯前端参考形态）。若按「插件 view 优先」，
   * 所有视图都会走 iframe 分支 —— 而本 Demo 不做 iframe 装载。
   *
   * 所以这里按「本地注册优先」。
   * **迁回 osteosome 时把这段顺序换回来**（那时本地表是空的，等价）。
   *
   * @param {string} id
   * @param {Array<{id:string,title:string,pluginId:string,entry:string}>} [pluginViews]
   */
  function resolveWidget(id, pluginViews) {
    const local = localWidgets.get(id)
    if (local) {
      return { kind: 'local', id, title: local.title, component: local.component }
    }
    const views = pluginViews || []
    const view = views.find((v) => v.id === id)
    if (view) {
      return {
        kind: 'iframe',
        id,
        title: view.title,
        pluginId: view.pluginId,
        entry: view.entry,
      }
    }
    const retired = RETIRED_WIDGETS[id]
    if (retired) {
      return { kind: 'missing', id, title: retired.title, reason: 'removed' }
    }
    return { kind: 'missing', id, title: id, reason: 'unknown' }
  }

  /** 当前所有可用的 widget id（本地 + 插件声明） */
  function listWidgets(pluginViews) {
    const ids = new Set(localWidgets.keys())
    for (const v of pluginViews || []) ids.add(v.id)
    return Array.from(ids)
  }

  global.OST = global.OST || {}
  global.OST.registry = { defineWidget, resolveWidget, listWidgets, RETIRED_WIDGETS }
})(window)
