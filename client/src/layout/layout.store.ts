import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { DockviewApi, GroupviewPanelState, SerializedDockview } from 'dockview-core'
import { usePreferences } from '@/core-sdk/usePreferences'
import { resolveWidget } from '@/widgets/registry'
import { usePluginStore } from '@/stores/plugin.store'
import { applyDefaultLayout } from '@/panes/default-layout'
import { PANEL_COMPONENT, type PanelParams } from '@/panes/types'
import { panelWindowExists } from './window-manager'
import type { LayoutMode } from './types'

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 被拉出独立窗的面板：记住序列化状态与同组参考面板，关闭独立窗时据此原位恢复。 */
interface DetachedPanel {
  state: GroupviewPanelState
  /** 原所在分组内的邻近面板 id；为 null 表示该面板独占了原分组。 */
  referencePanel: string | null
}

function parseLayout(json: string): SerializedDockview | null {
  try {
    const value = JSON.parse(json) as SerializedDockview
    return value && typeof value === 'object' && value.grid && value.panels ? value : null
  } catch {
    return null
  }
}

function parseDetached(value: unknown): Record<string, DetachedPanel> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, DetachedPanel>) : {}
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
    /** 已拉出独立窗、暂不在工作台中的面板：panelId -> 恢复信息 */
    detachedPanels: {} as Record<string, DetachedPanel>,
  }),
  actions: {
    async bootstrap() {
      try {
        const preferences = await usePreferences().get()
        const parsed = preferences.layout ? parseLayout(preferences.layout) : null
        this.snapshot = parsed
        this.detachedPanels = parseDetached(preferences.detachedPanels)
        this.lastError = preferences.layout && !parsed ? '布局已损坏，已重置为默认' : null
      } catch {
        this.lastError = '加载布局失败，已使用默认布局'
        this.snapshot = null
        this.detachedPanels = {}
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
    /** 组件为最小单位：把 widget 放进当前激活面板；无面板则新建一个。
     *  停用 / 已卸载插件的 widget 不可加入。
     *
     *  P4：入参是 **widget id**，它可能解析成三种东西（本地组件 / 插件 iframe / 已退役占位）。
     *  只有前两种能加 —— 占位是给**已有布局**看的，不该被新增进来。
     *  这也是为什么参数名没从 `widgetId` 改成 `viewId`：widget id 就是持久化主键，
     *  插件视图沿用同一个 id（同名 = 组件在原地换了实现 = 用户拖的位置不丢）。 */
    addWidget(widgetId: string) {
      const api = this.api as DockviewApi | null
      const widget = resolveWidget(widgetId, usePluginStore().all)
      if (!api || widget.kind === 'missing') return
      if (!usePluginStore().isWidgetEnabled(widgetId)) return
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
    /** 插件卸载后：把其组件从所有面板 params 中剔除。
     *  仅停用不清洗（PanelContainer 隐藏即可，重新启用后自动恢复）。 */
    reconcilePlugins() {
      const api = this.api as DockviewApi | null
      if (!api) return
      const plugins = usePluginStore()
      let changed = false
      for (const panel of api.panels) {
        const current = (panel.params as PanelParams | undefined)?.widgets ?? []
        const next = current.filter((id) => {
          const owner = plugins.pluginForWidget(id)
          return !owner || plugins.isInstalled(owner.id)
        })
        if (next.length !== current.length) {
          panel.api.updateParameters({ widgets: next })
          changed = true
        }
      }
      if (changed) this.updateLayout(api.toJSON())
    },
    newPanel() {
      const api = this.api as DockviewApi | null
      if (!api) return
      api.addPanel({ id: `panel.${Date.now()}`, component: PANEL_COMPONENT, title: '工作台', params: { widgets: [] } })
    },
    /**
     * 重置布局（S6 面板头「重置为对话布局」也走这里）：清空所有面板 → 重铺默认布局。
     *
     * 显式 `updateLayout(api.toJSON())`：不能只依赖 `api.clear()` 触发的 onDidLayoutChange ——
     * 那条回调是异步的，App 紧接着退出/刷新的话复位就丢了，重启后又看到拖乱的旧布局。
     */
    resetLayout() {
      const api = this.api as DockviewApi | null
      if (!api) return
      api.clear()
      applyDefaultLayout(api)
      this.updateLayout(api.toJSON())
    },
    /** 拉出独立窗：把面板从工作台摘除并记住状态，关闭独立窗时再放回原位。
     *  `api.close()` 会触发 onDidLayoutChange，由 DockviewLayout 回写快照，无需在此重复 updateLayout。 */
    detachPanel(panelId: string): boolean {
      const api = this.api as DockviewApi | null
      const panel = api?.getPanel(panelId)
      if (!api || !panel) return false
      this.detachedPanels[panelId] = {
        state: panel.toJSON(),
        referencePanel: panel.group.panels.find((item) => item.id !== panelId)?.id ?? null,
      }
      panel.api.close()
      return true
    },
    /** 独立窗关闭：把面板按原样（尽量回原 tab 组）放回工作台。幂等。 */
    restorePanel(panelId: string): void {
      const api = this.api as DockviewApi | null
      const record = this.detachedPanels[panelId]
      if (!api || !record) return
      delete this.detachedPanels[panelId]
      if (api.getPanel(panelId)) return
      const reference = record.referencePanel ? api.getPanel(record.referencePanel) : undefined
      const options = {
        id: record.state.id,
        component: record.state.contentComponent ?? PANEL_COMPONENT,
        title: record.state.title ?? '工作台',
        params: record.state.params ?? { widgets: [] },
      }
      api.addPanel(reference ? { ...options, position: { referencePanel: reference, direction: 'within' } } : options)
    },
    /** 载入持久化布局后，把「独立窗已不存在」（App 重启过）的面板放回工作台；
     *  独立窗仍开着的（仅主窗刷新）保持等待，关窗时由事件恢复。 */
    async reconcileDetached(): Promise<void> {
      for (const panelId of Object.keys(this.detachedPanels)) {
        if (await panelWindowExists(panelId)) continue
        this.restorePanel(panelId)
      }
    },
    scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void this.saveNow(), 500)
    },
    async saveNow() {
      this.saving = true
      try {
        await usePreferences().patch({
          layout: this.snapshot ? JSON.stringify(this.snapshot) : '',
          detachedPanels: this.detachedPanels,
        })
        this.lastError = null
      } catch {
        this.lastError = '保存布局失败'
      } finally {
        this.saving = false
      }
    },
  },
})
