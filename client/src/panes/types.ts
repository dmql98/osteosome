import type { Component } from 'vue'

export interface PaneDefinition {
  id: string
  title: string
  icon?: string
  component: () => Promise<{ default: Component }>
  defaultSlot?: { area: 'left' | 'right' | 'bottom'; index: number }
  windowable?: boolean
  minSize?: { w: number; h: number }
  onBeforeClose?: () => boolean | Promise<boolean>
}
