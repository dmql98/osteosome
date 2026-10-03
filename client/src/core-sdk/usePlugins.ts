/**
 * 插件清单的数据源（S7-3）：`GET /api/plugins` + `plugin.state.changed`。
 *
 * ## 为什么清单走 HTTP 拉而不是塞进 SSE 首帧
 *
 * 清单是「拉一次就够」的静态形状（装了哪些、谁依赖谁），状态跃迁已经由事件推。
 * 塞进 SSE 首帧会让每个连上来的页面都先收一份全量清单 —— 包括那些只关心
 * 某一个面板的窗口。
 *
 * ## 事件只改状态，不改清单
 *
 * `plugin.state.changed` 的载荷是**一个插件一条**（带 pluginId），所以这里
 * 直接按 id 打补丁。清单结构变了（装了/卸了插件）要走 `rescan`，
 * Core 会为每个插件各发一条 —— 前端全部应用即可。
 *
 * ## 离线时不阻塞界面
 *
 * 拉不到清单就让 `views` 保持空数组并照常返回。插件窗会显示「未连接」，
 * 而不是整窗崩掉 —— 清单是增强，不是主路径。
 */
import { onMounted, onUnmounted } from 'vue'
import { usePluginStore } from '@/stores/plugin.store'
import type { PluginListResponse } from '@/plugins/registry'
import { sse } from './sse'

export function usePlugins() {
  const store = usePluginStore()
  let dispose: (() => void) | null = null

  async function load(): Promise<void> {
    try {
      const response = await fetch('/api/plugins')
      if (!response.ok) return
      const body = (await response.json()) as PluginListResponse
      store.applyCatalog(body)
    } catch {
      // 离线：保持空清单，界面显示未连接
    }
  }

  onMounted(() => {
    dispose = sse.subscribe('plugin.state.changed', (payload) => {
      if (payload && typeof payload === 'object') {
        store.applyStateChange(payload as Parameters<typeof store.applyStateChange>[0])
      }
    })
    // 清单与偏好**都要在这里拉**，不能指望主窗口已经拉过。
    //
    // 插件列表窗 / 详情窗是独立的窗口，各有各的 JS 上下文与 pinia ——
    // 主窗口的 `bootstrap()` 对它们无效。S7-3 把两个窗口里的 bootstrap 删掉之后，
    // 如果不在这里补上，`enabled` / `uninstalled` 就永远是空的：
    // 界面会把已停用的插件显示成启用中，而且没有任何报错。
    void store.bootstrap()
    void load()
  })
  onUnmounted(() => {
    dispose?.()
    dispose = null
  })

  return { store, reload: load }
}