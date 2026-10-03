import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLayoutStore } from '../../src/layout/layout.store'
import { usePreferences } from '../../src/core-sdk/usePreferences'
import { usePluginStore } from '../../src/stores/plugin.store'
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
    // S7-4 起 setEnabled/uninstall 会先发 plugin.stop / plugin.start，
    // 命令失败就不写偏好。所以凡是依赖「插件被停用/卸载」的用例，
    // 都必须让命令成功 —— 否则它测到的不是布局逻辑，而是「命令失败时的短路」。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
    preferences.mockReturnValue({ get: vi.fn(), patch: put })
    const store = useLayoutStore()
    store.updateLayout({ ...validLayout, panels: { 'panel.changed': {} } } as never)
    await vi.advanceTimersByTimeAsync(500)
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ layout: expect.stringContaining('panel.changed') }))
  })

  it('addWidget 把组件加入当前激活面板 params', () => {
    const store = useLayoutStore()
    const panel = { id: 'panel.main', params: { widgets: ['widget.service-status'] }, api: { setActive: vi.fn(), updateParameters: vi.fn() } }
    store.attachApi(fakeApi(panel) as never)
    store.addWidget('widget.session-list')
    expect(panel.api.updateParameters).toHaveBeenCalledWith({ widgets: ['widget.service-status', 'widget.session-list'] })
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

  it('addWidget 跳过已停用插件的组件', async () => {
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn(), patch: vi.fn().mockResolvedValue(undefined) })
    const store = useLayoutStore()
    const panel = { id: 'panel.main', params: { widgets: [] }, api: { setActive: vi.fn(), updateParameters: vi.fn() } }
    store.attachApi(fakeApi(panel) as never)
    // S7-3：组件归属来自 Core 清单（以前在前端常量里，启动即有）。
    // 不先喂清单的话 isWidgetEnabled 找不到归属 -> 视为「始终可用」-> 这条会假通过。
    const plugins = usePluginStore()
    plugins.applyCatalog({
      layer: 'ok',
      problems: [],
      cycles: [],
      plugins: [
        {
          manifest: { id: 'workbench', name: '工作台外壳', version: '1.0.0', services: [], components: ['widget.service-status'] },
          installed: true,
          state: 'ready',
          reason: '',
          missingDependencies: [],
          missingOptional: [],
          unhealthyServices: [],
          readyServiceCount: 0,
          serviceStates: {},
        },
      ],
    })
    await plugins.setEnabled('workbench', false)
    store.addWidget('widget.service-status')
    expect(panel.api.updateParameters).not.toHaveBeenCalled()
  })

  it('reconcilePlugins 剔除已卸载插件的组件', async () => {
    const preferences = usePreferences as unknown as ReturnType<typeof vi.fn>
    preferences.mockReturnValue({ get: vi.fn(), patch: vi.fn().mockResolvedValue(undefined) })
    const store = useLayoutStore()
    const updateParameters = vi.fn()
    const panel = {
      id: 'panel.main',
      params: { widgets: ['widget.service-status', 'widget.system-info'] },
      api: { setActive: vi.fn(), updateParameters },
    }
    const api = { panels: [panel], activePanel: panel, addPanel: vi.fn(), clear: vi.fn(), toJSON: vi.fn(() => ({ grid: {}, panels: {} })) }
    store.attachApi(api as never)
    // S7-3：组件归属不再由前端常量提供，所以这里必须先喂一份 Core 清单 ——
    // reconcilePlugins 现在问的是 store.pluginForWidget()，清单为空时它谁都不认，
    // 于是「剔除」这条路径根本不会被走到（测试会假通过）。
    const plugins = usePluginStore()
    plugins.applyCatalog({
      layer: 'ok',
      problems: [],
      cycles: [],
      plugins: [
        {
          manifest: { id: 'workbench', name: '工作台外壳', version: '1.0.0', services: [], components: ['widget.system-info'] },
          installed: true,
          state: 'ready',
          reason: '',
          missingDependencies: [],
          missingOptional: [],
          unhealthyServices: [],
          readyServiceCount: 0,
          serviceStates: {},
        },
        {
          manifest: { id: 'models', name: '模型接入', version: '1.0.0', services: [], components: ['widget.service-status'] },
          installed: true,
          state: 'ready',
          reason: '',
          missingDependencies: [],
          missingOptional: [],
          unhealthyServices: [],
          readyServiceCount: 0,
          serviceStates: {},
        },
      ],
    })
    // 卸「拥有 service-status 的那个」，system-info 属于另一个插件，必须留着 ——
    // 这样这条断言才真的在验「按归属剔除」，而不是「全清空」
    await plugins.uninstall('models')
    store.reconcilePlugins()
    expect(updateParameters).toHaveBeenCalledWith({ widgets: ['widget.system-info'] })
  })

  it('清单还没拉到手时 reconcilePlugins 不动任何面板（而不是把所有组件都当孤儿剔除）', () => {
    const store = useLayoutStore()
    const updateParameters = vi.fn()
    const panel = {
      id: 'panel.main',
      params: { widgets: ['widget.service-status'] },
      api: { setActive: vi.fn(), updateParameters },
    }
    const api = { panels: [panel], activePanel: panel, addPanel: vi.fn(), clear: vi.fn(), toJSON: vi.fn(() => ({ grid: {}, panels: {} })) }
    store.attachApi(api as never)
    store.reconcilePlugins()
    // 清单为空 -> 没有插件认领任何组件 -> 按「未登记归属 = 始终可用」处理，一个都不该动。
    // 这条是 S7-3 引入的新风险：以前归属在前端常量里，启动即有；
    // 现在它来自 HTTP，若把「查不到归属」当成「已卸载」就会在冷启动瞬间清空所有面板。
    expect(updateParameters).not.toHaveBeenCalled()
  })
})
