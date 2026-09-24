import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { DockviewApi, SerializedDockview } from 'dockview-core'
import { usePreferences } from '@/core-sdk/usePreferences'
import { getWidget } from '@/widgets/registry'
import { applyDefaultLayout } from '@/panes/default-layout'
import { PANEL_COMPONENT, type PanelParams } from '@/panes/types'
import type { LayoutMode } from './types'

let saveTimer: ReturnType<typeof setTimeout> | null = null

function parseLayout(json: string): SerializedDockview | null {
  try {
    const value = JSON.parse(json) as SerializedDockview
    return value && typeof value === 'object' && value.grid && value.panels ? value : null
  } catch {
    return null
  }
}

export const useLayoutStore = defineStore('layout', {
  state: () => ({
    mode: 'edit' as LayoutMode,
    /** dockview 原生序列化布局（真源即 dockview 的 toJSON） */
    snapshot: null as SerializedDockview | null,
    api: null as DockviewApi | null,
    hydrated: false,
    saving: false,
    lastError: null as string | null,
  }),
  actions: {
    async bootstrap() {
      try {
        const preferences = await usePreferences().get()
        const parsed = preferences.layout ? parseLayout(preferences.layout) : null
        this.snapshot = parsed
        this.lastError = preferences.layout && !parsed ? '布局已损坏，已重置为默认' : null
      } catch {
        this.lastError = '加载布局失败，已使用默认布局'
        this.snapshot = null
      } finally {
        this.hydrated = true
      }
    },
    attachApi(api: DockviewApi | null) {
      this.api = api ? markRaw(api) : null
    },
    updateLayout(next: SerializedDockview) {
      this.snapshot = next
      this.scheduleSave()
    },
    setMode(mode: LayoutMode) {
      this.mode = mode
    },
    /** 组件为最小单位：把 widget 放进当前激活面板；无面板则新建一个 */
    addWidget(widgetId: string) {
      const api = this.api as DockviewApi | null
      const widget = getWidget(widgetId)
      if (!api || !widget) return
      const panel = api.activePanel
      if (!panel) {
        api.addPanel({ id: `panel.${Date.now()}`, component: PANEL_COMPONENT, title: '工作台', params: { widgets: [widgetId] } })
        return
      }
      const current = (panel.params as PanelParams | undefined)?.widgets ?? []
      if (current.includes(widgetId)) {
        panel.api.setActive()
        return
      }
      panel.api.updateParameters({ widgets: [...current, widgetId] })
      this.updateLayout(api.toJSON())
    },
    newPanel() {
      const api = this.api as DockviewApi | null
      if (!api) return
      api.addPanel({ id: `panel.${Date.now()}`, component: PANEL_COMPONENT, title: '工作台', params: { widgets: [] } })
    },
    resetLayout() {
      const api = this.api as DockviewApi | null
      if (!api) return
      api.clear()
      applyDefaultLayout(api)
    },
    scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void this.saveNow(), 500)
    },
    async saveNow() {
      this.saving = true
      try {
        await usePreferences().put({ layout: this.snapshot ? JSON.stringify(this.snapshot) : '' })
        this.lastError = null
      } catch {
        this.lastError = '保存布局失败'
      } finally {
        this.saving = false
      }
    },
  },
})
