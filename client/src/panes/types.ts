/** dockview 面板容器组件名（所有面板都是它，差异在 params.widgets） */
export const PANEL_COMPONENT = 'panel'

/** 面板容器参数：内部承载的组件（widget）id 列表 */
export interface PanelParams {
  widgets?: string[]
}
