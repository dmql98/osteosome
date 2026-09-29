import { describe, expect, it, vi } from 'vitest'
import { openPanelWindow, onPanelWindowClosed, panelWindowExists, paneWindowCount, closeAllPaneWindows, openPluginWindow, pluginWindowOpen, closePluginWindow, openPluginDetailWindow, closeAllPluginDetailWindows } from '../../src/layout/window-manager'

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

  it('面板独立窗关闭触发主窗回调（浏览器回退）', async () => {
    const listeners: Record<string, () => void> = {}
    const popup = {
      closed: false,
      focus: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, handler: () => void) => { listeners[type] = handler },
    } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    const onClosed = vi.fn()
    await onPanelWindowClosed(onClosed)

    openPanelWindow('panel.closed', [])
    listeners.beforeunload?.()
    expect(onClosed).toHaveBeenCalledWith('panel.closed')

    closeAllPaneWindows()
    open.mockRestore()
  })

  it('非 Tauri 环境 panelWindowExists 恒为 false', async () => {
    await expect(panelWindowExists('panel.x')).resolves.toBe(false)
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

  it('插件详情独立窗：同一插件单例、重复打开聚焦', () => {
    const popup = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), close: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    expect(openPluginDetailWindow('plugin.workbench')).toBe(popup)
    expect(openPluginDetailWindow('plugin.workbench')).toBe(popup)
    expect(open).toHaveBeenCalledTimes(1)
    closeAllPluginDetailWindows()
    expect(popup.close).toHaveBeenCalled()
    open.mockRestore()
  })
})
