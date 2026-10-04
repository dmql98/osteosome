import type { Component } from 'vue'

/** 工作台最小单元：一个可放进面板（panel）的组件 */
export interface WidgetDefinition {
  id: string
  title: string
  component: () => Promise<{ default: Component }>
}

/**
 * 插件声明的一个命名视图（`plugin.json` 的 `ui.views[]`，Core 原样透出）。
 *
 * 注意 `entry` 与 `src` 是两件事：`entry` 是**插件自己写的**相对路径
 * （`index.html` / `index.html#timeline`），`src` 是 Core 上那个 URL 的拼法。
 * 拼 URL 的活儿放在这里（`pluginViewSrc`），因为「命名空间前缀」是本文件的责任 ——
 * P2 的注释里写过：Core 路由带 `/plugins/<id>/ui/` 前缀正是为了让各插件的
 * bundle 不抢同一个全局 `/assets/xxx.js`。
 */
export interface PluginUiView {
  id: string
  title: string
  entry: string
}

/** 视图 id → 它在 Core 上的 URL。hash 部分浏览器不会发给服务器，但必须留在 src 里 */
export function pluginViewSrc(pluginId: string, entry: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/ui/${entry}`
}

/**
 * 一个 widget id 解析出来的**是什么**。
 *
 * 三种形态必须能被区分，而不是都退化成「一个组件」：
 *
 * · `local`  —— 还在 client 包里的 `.vue` 组件（迁移期：10 个内置 widget 都还是）
 * · `iframe` —— 插件 `dist/ui/` 里的页面，由 Core 同源伺服（P3 的路由）
 * · `missing`—— **曾经存在，现在不在了**。用户布局里存着这个 id
 *
 * `missing` 是这轮新增的第三种，也是最容易被省掉的那种。省略它的症状是：
 * 插件被卸载 / 组件改名之后，用户的面板里那个盒子**直接消失**，
 * 而他并没有做过任何操作 —— 「我拖好的布局怎么少了一个」。
 * 显式画一个占位（「该组件已被移除」）把真相说出来，用户才知道该重新摆。
 */
export type ResolvedWidget =
  | { kind: 'local'; id: string; title: string; /** 已包成异步组件，模板可以直接 `:is` */
      component: Component }
  | { kind: 'iframe'; id: string; title: string; pluginId: string; src: string }
  | {
      kind: 'missing'
      id: string
      /** 展示名：能从退役表里查到就给出当时的标题，否则就是 id 本身 */
      title: string
      /** 为什么会缺：`removed` = 我们明确删了；`unknown` = 从来没见过这个 id */
      reason: 'removed' | 'unknown'
    }