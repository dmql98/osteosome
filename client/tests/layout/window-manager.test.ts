import { describe, expect, it, vi } from 'vitest'
import { openPaneWindow, paneWindowCount, closeAllPaneWindows } from '../../src/layout/window-manager'

describe('window-manager', () => {
  it('同一 Pane 不重复打开，弹窗被拦截返回 null', () => {
    const popup = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), close: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(popup).mockReturnValueOnce(null)
    expect(openPaneWindow('pane.hello')).toBe(popup)
    expect(openPaneWindow('pane.hello')).toBe(popup)
    expect(open).toHaveBeenCalledTimes(1)
    expect(paneWindowCount()).toBe(1)
    expect(openPaneWindow('pane.blocked')).toBeNull()
    closeAllPaneWindows()
    open.mockRestore()
  })
})
