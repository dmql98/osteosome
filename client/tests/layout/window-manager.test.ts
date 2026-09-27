import { describe, expect, it, vi } from 'vitest'
import { openPanelWindow, paneWindowCount, closeAllPaneWindows, openPluginWindow, pluginWindowOpen, closePluginWindow } from '../../src/layout/window-manager'

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

  it('插件列表独立窗：单例、重复打开聚焦、关闭后置空', () => {
    const popup = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), close: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    expect(openPluginWindow()).toBe(popup)
    expect(openPluginWindow()).toBe(popup)
    // 同一时刻只开一个，第二次只聚焦不新开
    expect(open).toHaveBeenCalledTimes(1)
    expect(pluginWindowOpen()).toBe(true)
    closePluginWindow()
    expect(popup.close).toHaveBeenCalled()
    open.mockRestore()
  })
})
