/**
 * 系统目录选择框 —— **只在 Tauri 壳里存在**，浏览器（Vite dev + Core）下没有这个能力。
 *
 * 为什么每一步都可能拿不到能力（下一个人别再查一遍）：
 * 插件 UI 是**同源 iframe**（Core 伺服 `/plugins/<id>/ui/`）。Tauri v2 的 IPC 初始化脚本
 * 只注入主 frame；只有 Windows 上「窗口与 iframe 同源」时 invoke 才可能可达，
 * 而且历史上回调还被路由到父窗口。所以这里不能假设它能用 ——
 * **拿不到就明确报「不可用」**，由调用方提示用户手输，而不是弹一个必然失败的框。
 *
 * 用 `import()` 而不是顶层 import：浏览器用户永远不需要这份包的字节。
 * 用户取消 / 权限不足 / IPC 不可达在 UI 上是两件事 —— 前者「没选」，后者要提示。
 */
import type { OpenDialogOptions } from '@tauri-apps/plugin-dialog'

export type PickResult =
  | { status: 'ok'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }

/**
 * 当前页面跑在 Tauri 壳里吗。
 *
 * `isTauri` 由 Tauri 的初始化脚本定义，**只在主 frame** —— 插件 iframe 自己没有，
 * 所以要看 `window.parent`（同源，读得到）。浏览器下父子都没有 → false。
 */
export function inTauriShell(): boolean {
  if (typeof window === 'undefined') return false
  const flag = (w: Window): boolean => (w as unknown as { isTauri?: boolean }).isTauri === true
  if (flag(window)) return true
  return window.parent !== window && flag(window.parent)
}

/** 弹系统目录选择框。永不抛异常。 */
export async function pickDirectory(title: string): Promise<PickResult> {
  if (!inTauriShell()) return { status: 'unavailable' }
  try {
    const options: OpenDialogOptions = { directory: true, multiple: false, title }
    const picked: unknown = await (await import('@tauri-apps/plugin-dialog')).open(options)
    if (typeof picked !== 'string' || picked.length === 0) return { status: 'cancelled' }
    return { status: 'ok', path: picked }
  } catch {
    // IPC 不可达 / 能力没开 / 包加载失败 —— 对用户都是同一件事：这里选不了
    return { status: 'unavailable' }
  }
}
