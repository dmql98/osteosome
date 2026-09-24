import type { PaneId } from './types'

const popups = new Map<PaneId, Window>()

export function openPanelWindow(panelId: PaneId, widgetIds: string[]): Window | null {
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

export function getPaneWindow(panelId: PaneId): Window | null { return popups.get(panelId) ?? null }
export function paneWindowCount(): number { return popups.size }
export function closeAllPaneWindows(): void { for (const popup of popups.values()) popup.close(); popups.clear() }
