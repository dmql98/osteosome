import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLayoutStore } from '../../src/layout/layout.store'
import { defaultWorkspace } from '../../src/layout/layout.model'
import { usePreferences } from '../../src/core-sdk/usePreferences'

vi.mock('../../src/core-sdk/usePreferences', () => ({ usePreferences: vi.fn() }))

describe('layout.store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useRealTimers()
  })

  it('bootstrap 读取有效布局并标记 hydrated', async () => {
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    const ws = defaultWorkspace()
    preferences.mockReturnValue({ get: vi.fn().mockResolvedValue({ layout: JSON.stringify(ws) }), put: vi.fn() })
    const store = useLayoutStore()
    await store.bootstrap()
    expect(store.workspace).toEqual(ws)
    expect(store.hydrated).toBe(true)
    expect(store.lastError).toBeNull()
  })

  it('损坏布局回退默认布局并记录错误', async () => {
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn().mockResolvedValue({ layout: '{bad' }), put: vi.fn() })
    const store = useLayoutStore()
    await store.bootstrap()
    expect(store.workspace).toEqual(defaultWorkspace())
    expect(store.lastError).toContain('损坏')
  })

  it('updateWorkspace 防抖保存', async () => {
    vi.useFakeTimers()
    const put = vi.fn().mockResolvedValue(undefined)
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn(), put })
    const store = useLayoutStore()
    store.updateWorkspace({ ...store.workspace, dock: { kind: 'pane', id: 'pane.changed' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(put).toHaveBeenCalledWith({ layout: expect.stringContaining('pane.changed') })
  })
})
