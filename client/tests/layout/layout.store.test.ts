import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLayoutStore } from '../../src/layout/layout.store'
import { usePreferences } from '../../src/core-sdk/usePreferences'
import { panelWindowExists } from '../../src/layout/window-manager'

vi.mock('../../src/core-sdk/usePreferences', () => ({ usePreferences: vi.fn() }))
vi.mock('../../src/layout/window-manager', () => ({ panelWindowExists: vi.fn() }))

const validLayout = { grid: { root: { type: 'branch', data: [] }, width: 0, height: 0, orientation: 'HORIZONTAL' }, panels: {} }

function fakeApi(activePanel?: unknown) {
  const panels: Array<{ id: string; params?: unknown; api: { setActive: ReturnType<typeof vi.fn>; updateParameters: ReturnType<typeof vi.fn> } }> = []
  return {
    panels,
    activePanel,
    addPanel: vi.fn((options: { id: string; params?: unknown }) => {
      panels.push({ id: options.id, params: options.params, api: { setActive: vi.fn(), updateParameters: vi.fn() } })
    }),
    clear: vi.fn(() => { panels.length = 0 }),
    toJSON: vi.fn(() => ({ grid: {}, panels: {} })),
  }
}

describe('layout.store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useRealTimers()
  })

  it('bootstrap 读取 dockview 序列化布局并标记 hydrated', async () => {
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn().mockResolvedValue({ layout: JSON.stringify(validLayout) }), put: vi.fn() })
    const store = useLayoutStore()
    await store.bootstrap()
    expect(store.snapshot).toEqual(validLayout)
    expect(store.hydrated).toBe(true)
    expect(store.lastError).toBeNull()
  })

  it('损坏布局回退空快照并记录错误', async () => {
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn().mockResolvedValue({ layout: '{bad' }), put: vi.fn() })
    const store = useLayoutStore()
    await store.bootstrap()
    expect(store.snapshot).toBeNull()
    expect(store.lastError).toContain('损坏')
  })

  it('updateLayout 防抖保存 dockview 快照', async () => {
    vi.useFakeTimers()
    const put = vi.fn().mockResolvedValue(undefined)
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn(), put })
    const store = useLayoutStore()
    store.updateLayout({ ...validLayout, panels: { 'panel.changed': {} } } as never)
    await vi.advanceTimersByTimeAsync(500)
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ layout: expect.stringContaining('panel.changed') }))
  })

  it('addWidget 把组件加入当前激活面板 params', () => {
    const store = useLayoutStore()
    const panel = { id: 'panel.main', params: { widgets: ['widget.service-status'] }, api: { setActive: vi.fn(), updateParameters: vi.fn() } }
    store.attachApi(fakeApi(panel) as never)
    store.addWidget('widget.hello-command')
    expect(panel.api.updateParameters).toHaveBeenCalledWith({ widgets: ['widget.service-status', 'widget.hello-command'] })
  })

  it('addWidget 无面板时新建承载该组件的面板', () => {
    const store = useLayoutStore()
    const api = fakeApi()
    store.attachApi(api as never)
    store.addWidget('widget.service-status')
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ component: 'panel', params: { widgets: ['widget.service-status'] } }))
  })

  it('detachPanel 摘除面板并记住状态，restorePanel 回到原 tab 组', () => {
    const store = useLayoutStore()
    let closed = false
    const reference = { id: 'panel.b' }
    const target = {
      id: 'panel.a',
      toJSON: () => ({ id: 'panel.a', contentComponent: 'panel', title: '工作台', params: { widgets: ['widget.service-status'] } }),
      group: { panels: [{ id: 'panel.a' }, reference] },
      api: { close: vi.fn(() => { closed = true }) },
    }
    const api = {
      getPanel: vi.fn((id: string) => {
        if (id === 'panel.a') return closed ? undefined : target
        if (id === 'panel.b') return reference
        return undefined
      }),
      addPanel: vi.fn(),
      toJSON: vi.fn(() => ({ grid: {}, panels: {} })),
    }
    store.attachApi(api as never)

    expect(store.detachPanel('panel.a')).toBe(true)
    expect(target.api.close).toHaveBeenCalled()
    expect(store.detachedPanels['panel.a']).toBeTruthy()

    store.restorePanel('panel.a')
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'panel.a',
      component: 'panel',
      title: '工作台',
      params: { widgets: ['widget.service-status'] },
      position: { referencePanel: reference, direction: 'within' },
    }))
    expect(store.detachedPanels['panel.a']).toBeUndefined()
  })

  it('bootstrap 读取持久化的独立面板记录', async () => {
    const detachedPanels = { 'panel.a': { state: { id: 'panel.a' }, referencePanel: null } }
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn().mockResolvedValue({ layout: JSON.stringify(validLayout), detachedPanels }), put: vi.fn() })
    const store = useLayoutStore()
    await store.bootstrap()
    expect(store.detachedPanels).toEqual(detachedPanels)
  })

  it('reconcileDetached 只恢复独立窗已不存在的面板', async () => {
    const exists = panelWindowExists as unknown as ReturnType<typeof vi.fn>
    exists.mockImplementation(async (id: string) => id === 'panel.still')
    const store = useLayoutStore()
    const api = { getPanel: vi.fn(() => undefined), addPanel: vi.fn(), toJSON: vi.fn() }
    store.attachApi(api as never)
    const record = (id: string) => ({ state: { id, contentComponent: 'panel', title: '工作台', params: { widgets: [] } }, referencePanel: null })
    store.detachedPanels = { 'panel.still': record('panel.still'), 'panel.gone': record('panel.gone') }

    await store.reconcileDetached()
    expect(api.addPanel).toHaveBeenCalledTimes(1)
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'panel.gone' }))
    expect(store.detachedPanels['panel.gone']).toBeUndefined()
    expect(store.detachedPanels['panel.still']).toBeTruthy()
  })

  it('restorePanel 对未拉出/已存在的面板是空操作', () => {
    const store = useLayoutStore()
    const existing = { id: 'panel.x' }
    const api = { getPanel: vi.fn((id: string) => (id === 'panel.x' ? existing : undefined)), addPanel: vi.fn(), toJSON: vi.fn() }
    store.attachApi(api as never)
    store.restorePanel('panel.never')
    store.restorePanel('panel.x')
    expect(api.addPanel).not.toHaveBeenCalled()
  })

  it('newPanel 用原生 addPanel 建空面板，resetLayout 清空铺默认', () => {
    const store = useLayoutStore()
    const api = fakeApi()
    store.attachApi(api as never)
    store.newPanel()
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ component: 'panel', params: { widgets: [] } }))
    store.resetLayout()
    expect(api.clear).toHaveBeenCalled()
  })
})
