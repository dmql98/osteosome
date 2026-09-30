export interface Preferences {
  layout?: string
  /** 已拉出独立窗的面板：panelId -> { state, referencePanel }（见 layout.store DetachedPanel）。 */
  detachedPanels?: unknown
  /** 插件启用 / 卸载状态（见 stores/plugin.store）。 */
  plugins?: unknown
  [key: string]: unknown
}

/** 同一窗口内的写队列：patch 串行化，避免 layout / plugin 两处并发写互相覆盖。 */
let queue: Promise<void> = Promise.resolve()
let lastKnown: Preferences = {}

async function read(): Promise<Preferences> {
  const response = await fetch('/api/preferences')
  if (!response.ok) throw new Error(`preferences GET failed: ${response.status}`)
  const value = (await response.json()) as Preferences
  lastKnown = value && typeof value === 'object' ? value : {}
  return lastKnown
}

export function usePreferences() {
  const get = read

  /**
   * 合并式写入：读回当前偏好 → 浅合并 partial → 整体 PUT。
   * 串行执行，保证偏好里多个键（layout / detachedPanels / plugins）互不覆盖。
   * 读失败时退回本窗最后一次已知值，避免用空对象覆盖其它键。
   */
  const patch = (partial: Preferences): Promise<void> => {
    const run = async (): Promise<void> => {
      const base = await read().catch(() => lastKnown)
      const next = { ...base, ...partial }
      const response = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!response.ok) throw new Error(`preferences PUT failed: ${response.status}`)
      lastKnown = next
    }
    queue = queue.then(run, run)
    return queue
  }

  return { get, patch }
}
