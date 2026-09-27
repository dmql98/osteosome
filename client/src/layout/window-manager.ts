import type { PaneId } from './types'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isTauri, openPluginWindowViaTauri } from '../tauri/plugin-window'
import { PANEL_WINDOW_PREFIX, sanitizeWindowLabel } from '../tauri/window-registry'

const popups = new Map<PaneId, Window>()
/** 面板独立窗 → Tauri label 的映射（Tauri 环境下同步到 window-registry 供吸附轮询） */
const panelTauriLabels = new Map<PaneId, string>()

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
  const query = widgetIds.length ? `?w=${encodeURIComponent(widgetIds.join(','))}` : ''
  const url = `${window.location.origin}${window.location.pathname}#/pane/${encodeURIComponent(panelId)}${query}`
  const popup = window.open(url, `osteosome-panel-${panelId}`, 'popup,width=960,height=680')
  if (!popup) return null
  popups.set(panelId, popup)
  popup.addEventListener('beforeunload', () => { if (popups.get(panelId) === popup) popups.delete(panelId) }, { once: true })
  return popup
}

/** Tauri：面板独立窗 = 原生 WebviewWindow；已存在聚焦，否则新建并注册吸附 label */
export async function openPanelWindowViaTauri(panelId: PaneId, widgetIds: string[]): Promise<void> {
  const label = `${PANEL_WINDOW_PREFIX}${sanitizeWindowLabel(panelId)}`
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.setFocus()
    return
  }
  const query = widgetIds.length ? `?w=${encodeURIComponent(widgetIds.join(','))}` : ''
  const win = new WebviewWindow(label, {
    url: `#/pane/${encodeURIComponent(panelId)}${query}`,
    title: panelId,
    width: 960,
    height: 680,
    minWidth: 480,
    minHeight: 340,
    center: true,
    resizable: true,
  })
  if (win) {
    panelTauriLabels.set(panelId, label)
    // 开窗完成：不做吸附摆位（吸附方案已搁置）
  }
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

