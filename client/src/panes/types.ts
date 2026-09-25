import type { Component } from 'vue'

/** dockview 面板容器组件名（所有面板都是它，差异在 params.widgets） */
export const PANEL_COMPONENT = 'panel'

/** 面板容器参数：内部承载的组件（widget）id 列表 */
export interface PanelParams {
  widgets?: string[]
}

/** 旧 Pane 注册契约；保留给独立 Pane 路由和 P1b 兼容代码。 */
export interface PaneDefinition {
  id: string
  title: string
  icon?: string
  defaultSlot?: { area: 'left' | 'right' | 'bottom'; index: number }
  windowable?: boolean
  component: () => Promise<{ default: Component }>
  onBeforeClose?: () => boolean | Promise<boolean>
}
