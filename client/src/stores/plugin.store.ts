import { defineStore } from 'pinia'
import { usePreferences } from '@/core-sdk/usePreferences'
import { getPlugin, listPlugins, pluginForWidget, type PluginDefinition } from '@/plugins/registry'

interface PluginPrefs {
  enabled?: Record<string, boolean>
  uninstalled?: string[]
}

function parsePluginPrefs(value: unknown): PluginPrefs {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PluginPrefs) : {}
}

/**
 * 插件状态：启用 / 停用 / 卸载。默认全部启用、全部已安装。
 * 状态写回 /api/preferences 的 `plugins` 键；跨窗变更由 layout/window-events 广播。
 */
export const usePluginStore = defineStore('plugins', {
  state: () => ({
    /** 仅记录显式停用（false）；缺省即启用 */
    enabled: {} as Record<string, boolean>,
    uninstalled: [] as string[],
    hydrated: false,
    /** 可见状态版本号：每次启用/停用/卸载自增，供组件 watch 触发重算。 */
    revision: 0,
  }),
  getters: {
    installed(state): PluginDefinition[] {
      return listPlugins().filter((plugin) => !state.uninstalled.includes(plugin.id))
    },
    isInstalled: (state) => (pluginId: string) => !state.uninstalled.includes(pluginId),
    isEnabled: (state) => (pluginId: string) =>
      !state.uninstalled.includes(pluginId) && state.enabled[pluginId] !== false,
    /** widget 是否可用：未登记归属的 widget 视为始终可用。 */
    isWidgetEnabled: (state) => (widgetId: string) => {
      const plugin = pluginForWidget(widgetId)
      if (!plugin) return true
      return !state.uninstalled.includes(plugin.id) && state.enabled[plugin.id] !== false
    },
  },
  actions: {
    async bootstrap() {
      try {
        const prefs = parsePluginPrefs((await usePreferences().get()).plugins)
        this.enabled = { ...(prefs.enabled ?? {}) }
        this.uninstalled = Array.isArray(prefs.uninstalled) ? [...prefs.uninstalled] : []
      } catch {
        // 离线：保持默认（全部启用、全部已安装）
      }
      this.hydrated = true
      this.revision += 1
    },
    async setEnabled(pluginId: string, value: boolean) {
      if (!getPlugin(pluginId)) return
      this.enabled = { ...this.enabled, [pluginId]: value }
      this.revision += 1
      await this.save()
    },
    async toggle(pluginId: string) {
      await this.setEnabled(pluginId, !this.isEnabled(pluginId))
    },
    async uninstall(pluginId: string) {
      if (!getPlugin(pluginId) || this.uninstalled.includes(pluginId)) return
      this.uninstalled = [...this.uninstalled, pluginId]
      const { [pluginId]: _dropped, ...rest } = this.enabled
      this.enabled = rest
      this.revision += 1
      await this.save()
    },
    async save() {
      try {
        await usePreferences().patch({
          plugins: { enabled: this.enabled, uninstalled: this.uninstalled },
        })
      } catch {
        // 离线：忽略保存失败
      }
    },
  },
})
