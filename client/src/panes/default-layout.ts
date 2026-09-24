import type { DockviewApi } from 'dockview-core'
import { defaultWidgetIds } from '../widgets/registry'
import { PANEL_COMPONENT } from './types'

/** 无持久化布局时，用 dockview 原生 addPanel 铺一个承载默认组件的面板 */
export function applyDefaultLayout(api: DockviewApi): void {
  api.addPanel({
    id: 'panel.main',
    component: PANEL_COMPONENT,
    title: '工作台',
    params: { widgets: defaultWidgetIds() },
  })
}
