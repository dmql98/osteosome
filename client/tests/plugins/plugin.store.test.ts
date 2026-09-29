import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePluginStore } from '../../src/stores/plugin.store'
import { usePreferences } from '../../src/core-sdk/usePreferences'

vi.mock('../../src/core-sdk/usePreferences', () => ({ usePreferences: vi.fn() }))

function mockPrefs(initial: unknown = {}) {
  const patch = vi.fn().mockResolvedValue(undefined)
  const get = vi.fn().mockResolvedValue(initial)
  ;(usePreferences as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ get, patch })
  return { get, patch }
}

describe('plugin.store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认全部启用、全部已安装', () => {
    mockPrefs()
    const store = usePluginStore()
    expect(store.installed.length).toBe(3)
    expect(store.isEnabled('plugin.workbench')).toBe(true)
    expect(store.isWidgetEnabled('widget.service-status')).toBe(true)
  })

  it('setEnabled 写入 preferences.plugins 并停用其组件', async () => {
    const { patch } = mockPrefs()
    const store = usePluginStore()
    await store.setEnabled('plugin.service-manager', false)
    expect(store.isWidgetEnabled('widget.service-status')).toBe(false)
    expect(patch).toHaveBeenCalledWith({
      plugins: expect.objectContaining({ enabled: expect.objectContaining({ 'plugin.service-manager': false }) }),
    })
  })

  it('uninstall 从已安装列表移除并停止其组件', async () => {
    mockPrefs()
    const store = usePluginStore()
    await store.uninstall('plugin.event-stream')
    expect(store.isInstalled('plugin.event-stream')).toBe(false)
    expect(store.isWidgetEnabled('widget.event-stream')).toBe(false)
    expect(store.installed.map((plugin) => plugin.id)).not.toContain('plugin.event-stream')
  })

  it('bootstrap 读取持久化状态', async () => {
    mockPrefs({ plugins: { enabled: { 'plugin.workbench': false }, uninstalled: ['plugin.event-stream'] } })
    const store = usePluginStore()
    await store.bootstrap()
    expect(store.isEnabled('plugin.workbench')).toBe(false)
    expect(store.isInstalled('plugin.event-stream')).toBe(false)
    expect(store.hydrated).toBe(true)
  })
})
