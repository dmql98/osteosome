import type { PaneId } from './types'

const popups = new Map<PaneId, Window>()

export function openPaneWindow(paneId: PaneId): Window | null {
  const current = popups.get(paneId)
  if (current && !current.closed) {
    current.focus()
    return current
  }
  const url = `${window.location.origin}${window.location.pathname}#/pane/${encodeURIComponent(paneId)}`
  const popup = window.open(url, `osteosome-pane-${paneId}`, 'popup,width=960,height=680')
  if (!popup) return null
  popups.set(paneId, popup)
  popup.addEventListener('beforeunload', () => { if (popups.get(paneId) === popup) popups.delete(paneId) }, { once: true })
  return popup
}

export function getPaneWindow(paneId: PaneId): Window | null { return popups.get(paneId) ?? null }
export function paneWindowCount(): number { return popups.size }
export function closeAllPaneWindows(): void { for (const popup of popups.values()) popup.close(); popups.clear() }
