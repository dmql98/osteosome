/**
 * 主题（P4 WS-4）—— light / dark，经 `data-theme` 切换（tokens.css 已备两套变量）。
 *
 * - 切换即时生效：写 DOM `data-theme` + 写 preferences（`ui.theme`，刷新保持）；
 * - 挂载恢复：`initTheme` 读 preferences 设 data-theme（main.ts 调用，刷新即生效）。
 */
import { ref } from 'vue'

export type Theme = 'light' | 'dark'

export const DEFAULT_THEME: Theme = 'light'

const current = ref<Theme>(DEFAULT_THEME)

function apply(theme: Theme): void {
  current.value = theme
  document.documentElement.setAttribute('data-theme', theme)
}

/** 挂载时读 preferences 恢复主题（刷新即生效，不等异步完成才渲染——默认 light 先出） */
export async function initTheme(getPrefs: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const prefs = await getPrefs()
    if (prefs['ui.theme'] === 'light' || prefs['ui.theme'] === 'dark') {
      apply(prefs['ui.theme'] as Theme)
    } else {
      apply(DEFAULT_THEME)
    }
  } catch {
    apply(DEFAULT_THEME)
  }
}

export function useTheme() {
  /** 切换：同步改 DOM（立即生效）+ 返回 preferences patch 内容（调用方负责写） */
  function setTheme(theme: Theme): void {
    apply(theme)
  }

  function toggle(): Theme {
    const next: Theme = current.value === 'dark' ? 'light' : 'dark'
    apply(next)
    return next
  }

  return { theme: current, setTheme, toggle }
}
