/**
 * Tauri 原生独立窗适配（插件管理）。
 *
 * 壳（src-tauri）负责开真实原生窗口；前端只负责调用 WebviewWindow API。
 * 兼容降级：非 Tauri 环境（纯浏览器 / vitest）回落 window.open。
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

export const PLUGIN_WINDOW_LABEL = 'osteosome-plugin-list'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 用 Tauri 原生窗口打开插件列表；已存在则聚焦（单例）。 */
export async function openPluginWindowViaTauri(): Promise<boolean> {
  const existing = await WebviewWindow.getByLabel(PLUGIN_WINDOW_LABEL)
  if (existing) {
    await existing.setFocus()
    return true
  }
  const win = new WebviewWindow(PLUGIN_WINDOW_LABEL, {
    url: '#/plugin-list',
    title: '插件管理',
    width: 760,
    height: 620,
    minWidth: 480,
    minHeight: 340,
    center: true,
    resizable: true,
  })
  // 窗口吸附（边缘距主窗 ≤ 13px 贴边、并随主窗拖动）由 Rust 壳统一处理。
  return !!win
}

/** 关闭当前（插件管理）窗口 —— 关闭按钮用，Tauri 下走原生 close。 */
export async function closeCurrentWindowViaTauri(): Promise<void> {
  const current = WebviewWindow.getCurrent()
  await current.close()
}
