import type { PaneId } from './types'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isTauri, openPluginWindowViaTauri } from '../tauri/plugin-window'
import { PANEL_WINDOW_PREFIX, sanitizeWindowLabel } from '../tauri/window-registry'

const popups = new Map<PaneId, Window>()

/** 跨窗事件：面板独立窗关闭前广播该事件，主窗收到后把面板 tab 放回工作台。 */
const PANEL_CLOSED_EVENT = 'ost:panel-window-closed'

type PanelClosedHandler = (panelId: PaneId) => void
let panelClosedHandler: PanelClosedHandler | null = null
let panelClosedListening = false

/** 主窗订阅面板独立窗关闭。
 *  Tauri：壳在 on_window_event 里广播事件（见 src-tauri/src/lib.rs）；
 *  浏览器：由 popup 的 beforeunload 触发。 */
export async function onPanelWindowClosed(handler: PanelClosedHandler): Promise<void> {
  panelClosedHandler = handler
  if (panelClosedListening || !isTauri()) return
  panelClosedListening = true
  const { listen } = await import('@tauri-apps/api/event')
  await listen<string>(PANEL_CLOSED_EVENT, (event) => panelClosedHandler?.(event.payload))
}

/** 面板独立窗 label：供创建与存在性探测复用。 */
function panelWindowLabel(panelId: PaneId): string {
  return `${PANEL_WINDOW_PREFIX}${sanitizeWindowLabel(panelId)}`
}

/** 面板独立窗的路由片段 `#/pane/<id>?w=...`；Tauri 相对 app URL，浏览器再拼 origin + pathname。 */
function panelRoute(panelId: PaneId, widgetIds: string[]): string {
  const query = widgetIds.length ? `?w=${encodeURIComponent(widgetIds.join(','))}` : ''
  return `#/pane/${encodeURIComponent(panelId)}${query}`
}

/** 该面板的独立窗是否仍打开（Tauri）。用于刷新主窗后判断是等待关窗还是直接恢复。 */
export async function panelWindowExists(panelId: PaneId): Promise<boolean> {
  if (!isTauri()) return false
  return (await WebviewWindow.getByLabel(panelWindowLabel(panelId))) !== null
}

export function openPanelWindow(panelId: PaneId, widgetIds: string[]): Window | null {
  if (isTauri()) {
    void openPanelWindowViaTauri(panelId, widgetIds)
    return null
  }
  const current = popups.get(panelId)
  if (current && !current.closed) {
    current.focus()
    return current
  }
  const url = `${window.location.origin}${window.location.pathname}${panelRoute(panelId, widgetIds)}`
  const popup = window.open(url, panelWindowLabel(panelId), 'popup,width=960,height=680')
  if (!popup) return null
  popups.set(panelId, popup)
  popup.addEventListener('beforeunload', () => {
    if (popups.get(panelId) === popup) popups.delete(panelId)
    panelClosedHandler?.(panelId)
  }, { once: true })
  return popup
}

/** Tauri：面板独立窗 = 原生 WebviewWindow；已存在则聚焦，否则新建。
 *  窗口吸附（边缘距主窗 ≤ 13px 贴边、并随主窗拖动）由 Rust 壳统一处理，前端不做摆位。 */
export async function openPanelWindowViaTauri(panelId: PaneId, widgetIds: string[]): Promise<void> {
  const label = panelWindowLabel(panelId)
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.setFocus()
    return
  }
  // 吸附由 src-tauri 壳的 on_window_event 统一接管（见 src-tauri/src/lib.rs）。
  new WebviewWindow(label, {
    url: panelRoute(panelId, widgetIds),
    title: panelId,
    width: 960,
    height: 680,
    minWidth: 480,
    minHeight: 340,
    center: true,
    resizable: true,
  })
}

export function getPaneWindow(panelId: PaneId): Window | null { return popups.get(panelId) ?? null }
export function paneWindowCount(): number { return popups.size }
export function closeAllPaneWindows(): void { for (const popup of popups.values()) popup.close(); popups.clear() }

let pluginWindow: Window | null = null

/** 插件管理 = 独立原生窗（对齐 demo D1）。同一时刻至多一个，重复打开则聚焦。
 *  Tauri 环境用原生 WebviewWindow（src-tauri 壳负责真窗口），否则回退 window.open。 */
export function openPluginWindow(): Window | null {
  if (pluginWindow && !pluginWindow.closed) {
    pluginWindow.focus()
    return pluginWindow
  }
  if (isTauri()) {
    void openPluginWindowViaTauri()
    return null
  }
  const url = `${window.location.origin}${window.location.pathname}#/plugin-list`
  const popup = window.open(url, 'osteosome-plugin-list', 'popup,width=760,height=620')
  if (!popup) return null
  pluginWindow = popup
  popup.addEventListener('beforeunload', () => { if (pluginWindow === popup) pluginWindow = null }, { once: true })
  return popup
}

export function pluginWindowOpen(): boolean { return !!pluginWindow && !pluginWindow.closed }
export function closePluginWindow(): void { if (pluginWindow) pluginWindow.close(); pluginWindow = null }

