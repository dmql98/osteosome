import { defineStore } from 'pinia'
import { usePreferences } from '@/core-sdk/usePreferences'
import { useCommand } from '@/core-sdk/useCommand'
import { toPluginViews, pluginForWidgetIn, type PluginLayerStatus, type PluginView } from '@/plugins/registry'

interface PluginPrefs {
  enabled?: Record<string, boolean>
  uninstalled?: string[]
}

function parsePluginPrefs(value: unknown): PluginPrefs {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PluginPrefs) : {}
}

/**
 * 插件状态（S7-3）—— **清单来自 Core，不来自前端常量**。
 *
 * 两类数据要分清，混在一起就会出现「两个真源」：
 * · 清单（装了哪些、叫什么、依赖谁、什么状态）→ **Core 的事实**，存在 `views`
 * · 用户意愿（我停用了哪个、我卸了哪个）→ **本地偏好**，存在 `enabled` / `uninstalled`
 *
 * 所以 `installed` / `isInstalled` 读 Core 的 `snapshot.installed`，
 * 而 `isEnabled` 读本地 prefs —— 后者是「我主动关的」，Core 并不知道。
 */
export const usePluginStore = defineStore('plugins', {
  state: () => ({
    /** 从 Core 拉来的插件视图（未拉取时为空数组，不是 null —— 模板不用到处判空） */
    views: [] as PluginView[],
    /** 插件层状态。前端要靠它区分「没启用插件层」「插件层坏了」「真的一个都没装」 */
    layer: null as PluginLayerStatus | null,
    /** 插件目录路径。`missing-dir` 时要告诉用户「找的是哪个目录」 */
    pluginsDir: null as string | null,
    /** 扫盘问题与依赖环 —— 展示在列表窗顶部，不塞进每个插件条目 */
    problems: [] as { where: string; reason: string }[],
    cycles: [] as string[][],
    /** 仅记录显式停用（false）；缺省即启用 */
    enabled: {} as Record<string, boolean>,
    /** 已被用户卸掉的插件 id。Core 也认这个（`snapshot.installed` 就是按它算的） */
    uninstalled: [] as string[],
    hydrated: false,
    /** 可见状态版本号：清单更新或启用/停用/卸载时自增，供组件 watch 触发重算。 */
    revision: 0,
  }),
  getters: {
    /** 清单本身（Core 说了算）。`uninstalled` 已由 Core 折进 `snapshot.installed` */
    all(state): PluginView[] {
      return state.views
    },
    /**
     * 已安装的。
     *
     * 要**同时**看两处，缺一不可：
     * · `plugin.installed` —— Core 的判断（它读的是**启动时**的 prefs）
     * · `state.uninstalled` —— 用户刚刚做的动作
     *
     * 只看前者会「撒谎到重启」：运行期卸掉一个插件，Core 还没被通知，
     * `snapshot.installed` 仍是 true，于是界面还显示已安装，组件也还能加。
     * 只看后者则会在 Core 说「这插件没装」时把它显示出来。
     *
     * 这不算第二个真源：prefs 本来就是用户的意愿，而**前端是写它的那一方** ——
     * Core 只是启动时读了一次。
     */
    installed(state): PluginView[] {
      return this.all.filter(
        (plugin) => plugin.installed && !state.uninstalled.includes(plugin.id),
      )
    },
    byId(): (pluginId: string) => PluginView | undefined {
      return (pluginId) => this.all.find((plugin) => plugin.id === pluginId)
    },
    /** widget 归属哪个插件。未登记归属的 widget 返回 undefined —— 调用方应视为「始终可用」 */
    pluginForWidget(): (widgetId: string) => PluginView | undefined {
      return (widgetId) => pluginForWidgetIn(this.all, widgetId)
    },
    isInstalled(): (pluginId: string) => boolean {
      return (pluginId) => {
        const plugin = this.byId(pluginId)
        return plugin?.installed === true && !this.uninstalled.includes(pluginId)
      }
    },
    /** 用户是否启用。注意与 `installed` 的区别：这是「我主动关的」，Core 并不知道 */
    isEnabled(): (pluginId: string) => boolean {
      return (pluginId) => this.isInstalled(pluginId) && this.enabled[pluginId] !== false
    },
    isWidgetEnabled(): (widgetId: string) => boolean {
      return (widgetId) => {
        const plugin = this.pluginForWidget(widgetId)
        if (!plugin) return true
        return this.isEnabled(plugin.id)
      }
    },
    /** 插件层是否可用。前端据此决定显示「未启用插件层」还是「插件没装好」 */
    layerOk(state): boolean {
      return state.layer === 'ok'
    },
  },
  actions: {
    /** 用 Core 的响应覆盖清单。由 `@/core-sdk/usePlugins` 调用 */
    applyCatalog(
      payload: {
        layer: PluginLayerStatus
        pluginsDir?: string | null
        problems: { where: string; reason: string }[]
        cycles: string[][]
        /** Core 算的启停序。`builtin` 的判定要用它（见 PluginView.builtin） */
        installOrder?: string[]
        plugins: Parameters<typeof toPluginViews>[0]
      },
    ): void {
      this.views = toPluginViews(payload.plugins, payload.installOrder ?? [])
      this.layer = payload.layer
      this.pluginsDir = payload.pluginsDir ?? null
      this.problems = payload.problems
      this.cycles = payload.cycles
      this.revision += 1
    },
    /** 应用一条 `plugin.state.changed`。状态是 Core 派生的，前端只跟着改，不自己算 */
    applyStateChange(payload: {
      pluginId: string
      state: PluginView['state']
      reason?: string
      missingDependencies?: string[]
      readyServices?: number
      totalServices?: number
    }): void {
      const index = this.views.findIndex((p) => p.id === payload.pluginId)
      if (index < 0) return
      const current = this.views[index]!
      this.views = [
        ...this.views.slice(0, index),
        {
          ...current,
          state: payload.state,
          reason: payload.reason ?? current.reason,
          missingDependencies: payload.missingDependencies ?? current.missingDependencies,
          readyServiceCount: payload.readyServices ?? current.readyServiceCount,
          totalServices: payload.totalServices ?? current.totalServices,
        },
        ...this.views.slice(index + 1),
      ]
      this.revision += 1
    },
    /** 拉偏好。只管用户意愿，清单由 usePlugins 负责 —— 两者分开拉，失败互不影响 */
    async bootstrap(): Promise<void> {
      try {
        const prefs = parsePluginPrefs((await usePreferences().get()).plugins)
        this.enabled = { ...(prefs.enabled ?? {}) }
        this.uninstalled = Array.isArray(prefs.uninstalled) ? [...prefs.uninstalled] : []
      } catch {
        // 离线：保持默认（全部启用）
      }
      this.hydrated = true
      this.revision += 1
    },
    /**
     * 启用 / 停用 / 卸载（S7-4：**真的停进程**）。
     *
     * ## 顺序：先停/启，成功了才写偏好
     *
     * 反过来写会留下「界面说停了、进程还在跑」的偏差，而且**重启后进程真的没了** ——
     * 那是「撒谎到重启」的极端版本。所以命令失败时**不改偏好**：
     * 宁可界面显示「没停成功」，也不要留下一个假的停用状态。
     *
     * 实际是三者里最容易出偏差的一个 —— 因为「停用」在 Core 那边有两处生效点
     * （运行期命令 + 启动路径），任何一处漏了就会出现重启失效。
     */
    async setEnabled(pluginId: string, value: boolean): Promise<boolean> {
      if (!this.byId(pluginId)) return false
      const ok = await useCommand().send(value ? 'plugin.start' : 'plugin.stop', { pluginId })
      if (!ok) return false
      this.enabled = { ...this.enabled, [pluginId]: value }
      this.revision += 1
      await this.save()
      return true
    },
    async toggle(pluginId: string): Promise<boolean> {
      return this.setEnabled(pluginId, !this.isEnabled(pluginId))
    },
    /**
     * 卸载。
     *
     * 也要发 `plugin.stop`：Core 的启动路径已经认 `uninstalled`，
     * 但**运行期**它还没被通知 —— 不停的话进程会一直跑到 Core 退出。
     */
    async uninstall(pluginId: string): Promise<boolean> {
      if (!this.byId(pluginId) || this.uninstalled.includes(pluginId)) return false
      const ok = await useCommand().send('plugin.stop', { pluginId })
      if (!ok) return false
      this.uninstalled = [...this.uninstalled, pluginId]
      const { [pluginId]: _dropped, ...rest } = this.enabled
      this.enabled = rest
      this.revision += 1
      await this.save()
      return true
    },
    async save(): Promise<void> {
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