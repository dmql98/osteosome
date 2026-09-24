import { describe, expect, it, vi } from 'vitest'
import { openPanelWindow, paneWindowCount, closeAllPaneWindows } from '../../src/layout/window-manager'

describe('window-manager', () => {
  it('同一面板不重复打开，弹窗被拦截返回 null', () => {
    const popup = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), close: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(popup).mockReturnValueOnce(null)
    expect(openPanelWindow('panel.main', ['widget.hello-command'])).toBe(popup)
    expect(openPanelWindow('panel.main', ['widget.hello-command'])).toBe(popup)
    expect(open).toHaveBeenCalledTimes(1)
    expect(paneWindowCount()).toBe(1)
    expect(openPanelWindow('panel.blocked', [])).toBeNull()
    closeAllPaneWindows()
    open.mockRestore()
  })
})
