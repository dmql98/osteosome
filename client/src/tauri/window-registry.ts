/** 已打开的独立窗 label 集合（供主窗口吸附轮询驱动使用，跨模块共享）。 */

/** 面板独立窗 label 前缀（后面跟 sanitize 后的 panel id） */
export const PANEL_WINDOW_PREFIX = 'osteosome-panel-'

/** 已注册的面板独立窗 label */
export const panelWindowLabels = new Set<string>()

export function registerPanelLabel(label: string): () => void {
  panelWindowLabels.add(label)
  return () => panelWindowLabels.delete(label)
}

/** Tauri 窗口 label 只允许 a-zA-Z0-9-/:_，把 panel id 里的点等非法字符替换掉 */
export function sanitizeWindowLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9\-/:_]/g, '_')
}
