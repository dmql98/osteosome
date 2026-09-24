import type { Component } from 'vue'

/** 工作台最小单元：一个可放进面板（panel）的组件 */
export interface WidgetDefinition {
  id: string
  title: string
  component: () => Promise<{ default: Component }>
}
