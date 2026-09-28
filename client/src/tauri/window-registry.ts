/** 独立窗 label 约定（窗口吸附由 Rust 壳处理，这里只负责生成合法 label）。 */

/** 面板独立窗 label 前缀（后面跟 sanitize 后的 panel id） */
export const PANEL_WINDOW_PREFIX = 'osteosome-panel-'

/** Tauri 窗口 label 只允许 a-zA-Z0-9-/:_，把 panel id 里的点等非法字符替换掉 */
export function sanitizeWindowLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9\-/:_]/g, '_')
}
