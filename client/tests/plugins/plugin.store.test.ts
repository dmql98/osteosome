import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePluginStore } from '../../src/stores/plugin.store'
import { usePreferences } from '../../src/core-sdk/usePreferences'
import { toPluginViews, type PluginSnapshot } from '../../src/plugins/registry'

vi.mock('../../src/core-sdk/usePreferences', () => ({ usePreferences: vi.fn() }))

function mockPrefs(initial: unknown = {}) {
  const patch = vi.fn().mockResolvedValue(undefined)
  const get = vi.fn().mockResolvedValue(initial)
  ;(usePreferences as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ get, patch })
  return { get, patch }
}

/**
 * S7-4：启停真的会发命令，所以要能控制命令的成败。
 * 返回的 `calls` 就是「有没有真去停进程」的直接证据。
 */
function mockCommand(ok = true) {
  const send = vi.fn().mockResolvedValue(ok)
  globalThis.fetch = vi.fn().mockResolvedValue({ ok, status: ok ? 202 : 400 }) as never
  return { send, calls: send.mock.calls }
}

/**
 * S7-3：清单不再由前端自带，所以每个用例都要**先喂一份 Core 快照**。
 *
 * 这不是为了迁就测试，而是把「清单从哪来」显式化了 ——
 * 以前 `usePluginStore()` 之后清单就在那，现在得先 `applyCatalog`，
 * 于是「忘了拉清单」这种状态在测试里是可见的，而不是悄悄表现成「插件都没了」。
 */
function snap(id: string, components: string[], extra: Partial<PluginSnapshot> = {}): PluginSnapshot {
  return {
    manifest: { id, name: id, version: '1.0.0', services: [], components },
    installed: true,
    state: 'ready',
    reason: '',
    missingDependencies: [],
    missingOptional: [],
    unhealthyServices: [],
    readyServiceCount: 0,
    serviceStates: {},
    ...extra,
  }
}

function seedCatalog(over: Partial<PluginSnapshot>[] = []): void {
  const store = usePluginStore()
  store.applyCatalog({
    layer: 'ok',
    problems: [],
    cycles: [],
    plugins: [
      snap('workbench', ['widget.system-info', 'widget.service-status']),
      snap('models', ['widget.llm-providers']),
      snap('reliability', [], over[0] ?? {}),
    ],
  })
}

describe('plugin.store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('没拉清单时是空数组而不是 null（模板不用到处判空）', () => {
    mockPrefs()
    const store = usePluginStore()
    expect(store.all).toEqual([])
    expect(store.installed).toEqual([])
    expect(store.layer).toBeNull()
  })

  it('applyCatalog 之后清单按 Core 给的来，且 installed 由 Core 折算', () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    expect(store.installed.map((p) => p.id)).toEqual(['workbench', 'models', 'reliability'])
    expect(store.layer).toBe('ok')
    expect(store.layerOk).toBe(true)
  })

  it('Core 报 installed=false 的插件不进已安装列表（不再由前端自己筛 uninstalled）', () => {
    mockPrefs()
    const store = usePluginStore()
    store.applyCatalog({
      layer: 'ok',
      problems: [],
      cycles: [],
      plugins: [snap('models', [], { installed: false }), snap('workbench', [])],
    })
    expect(store.installed.map((p) => p.id)).toEqual(['workbench'])
    expect(store.isInstalled('models')).toBe(false)
  })

  it('layer 非 ok 时前端能区分「没装插件」与「插件层出问题」', () => {
    mockPrefs()
    const store = usePluginStore()
    store.applyCatalog({ layer: 'missing-dir', problems: [], cycles: [], plugins: [] })
    expect(store.layerOk).toBe(false)
    expect(store.all).toEqual([])
  })

  it('setEnabled 写入 preferences.plugins 并停用其组件', async () => {
    const { patch } = mockPrefs()
    mockCommand()
    seedCatalog()
    const store = usePluginStore()
    await store.setEnabled('workbench', false)
    expect(store.isWidgetEnabled('widget.service-status')).toBe(false)
    expect(patch).toHaveBeenCalledWith({
      plugins: expect.objectContaining({ enabled: expect.objectContaining({ workbench: false }) }),
    })
  })

  it('**停用会真发 plugin.stop**（S7-4：以前只写 prefs，一个进程都没停）', async () => {
    mockPrefs()
    mockCommand()
    seedCatalog()
    const store = usePluginStore()
    await store.setEnabled('models', false)
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.topic).toBe('plugin.stop')
    expect(body.payload).toEqual({ pluginId: 'models' })
  })

  it('启用发 plugin.start（方向不能反）', async () => {
    mockPrefs()
    mockCommand()
    seedCatalog()
    const store = usePluginStore()
    await store.setEnabled('models', true)
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).topic).toBe('plugin.start')
  })

  it('**命令失败时不写偏好**（否则界面说停了、进程还在，重启后进程真的没了）', async () => {
    const { patch } = mockPrefs()
    mockCommand(false)
    seedCatalog()
    const store = usePluginStore()
    const ok = await store.setEnabled('models', false)
    expect(ok).toBe(false)
    // 关键：偏好没被改，所以下次启动它还是启用的 —— 与「运行期其实没停成」一致
    expect(patch).not.toHaveBeenCalled()
    expect(store.isEnabled('models')).toBe(true)
  })

  it('卸载也发 plugin.stop（否则进程会一直跑到 Core 退出）', async () => {
    mockPrefs()
    mockCommand()
    seedCatalog()
    const store = usePluginStore()
    await store.uninstall('models')
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).topic).toBe('plugin.stop')
    expect(store.isInstalled('models')).toBe(false)
  })

  it('卸载失败时不改偏好，调用方能据此不关窗口', async () => {
    const { patch } = mockPrefs()
    mockCommand(false)
    seedCatalog()
    const store = usePluginStore()
    const ok = await store.uninstall('models')
    expect(ok).toBe(false)
    expect(patch).not.toHaveBeenCalled()
    expect(store.uninstalled).toEqual([])
  })

  it('setEnabled 对不存在的插件是 no-op（清单归 Core 管，前端不自己判存在性）', async () => {
    const { patch } = mockPrefs()
    mockCommand()
    seedCatalog()
    const store = usePluginStore()
    await store.setEnabled('ghost', false)
    expect(patch).not.toHaveBeenCalled()
  })

  it('isEnabled 区分「没装」与「我停用了」', async () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    expect(store.isEnabled('reliability')).toBe(true)
    await store.setEnabled('reliability', false)
    expect(store.isEnabled('reliability')).toBe(false)
    expect(store.isInstalled('reliability')).toBe(true)
  })

  it('uninstall 从已安装列表移除并停止其组件', async () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    await store.uninstall('models')
    expect(store.uninstalled).toContain('models')
    expect(store.installed.map((p) => p.id)).not.toContain('models')
    expect(store.isInstalled('models')).toBe(false)
    expect(store.enabled).toEqual({})
  })

  it('卸载后立刻从已安装列表消失，不等 Core 重新下发（否则界面撒谎到重启）', () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    // Core 只在启动时把 prefs 折进 snapshot.installed，运行期它还没被通知。
    // 如果只信 snapshot.installed，这里就还是 true —— 用户看到「已安装」，
    // 而重启之后它真的没了。
    expect(store.byId('models')!.installed).toBe(true)
    store.uninstalled = ['models']
    expect(store.installed.map((p) => p.id)).not.toContain('models')
  })

  it('applyStateChange 只改状态，不动清单结构（状态是 Core 派生的）', () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    store.applyStateChange({
      pluginId: 'reliability',
      state: 'degraded',
      reason: '缺必需依赖: models',
      missingDependencies: ['models'],
      readyServices: 0,
      totalServices: 1,
    })
    const reliability = store.byId('reliability')!
    expect(reliability.state).toBe('degraded')
    expect(reliability.reason).toBe('缺必需依赖: models')
    expect(reliability.missingDependencies).toEqual(['models'])
    // 其他插件不受影响
    expect(store.byId('workbench')!.state).toBe('ready')
    expect(store.all.length).toBe(3)
  })

  it('applyStateChange 对未知 pluginId 是 no-op（不凭空造条目）', () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    store.applyStateChange({ pluginId: 'ghost', state: 'failed' })
    expect(store.all.length).toBe(3)
    expect(store.byId('ghost')).toBeUndefined()
  })

  it('pluginForWidget 反查归属；未登记归属的 widget 视为始终可用', () => {
    mockPrefs()
    seedCatalog()
    const store = usePluginStore()
    expect(store.pluginForWidget('widget.llm-providers')?.id).toBe('models')
    expect(store.isWidgetEnabled('widget.unregistered')).toBe(true)
  })

  it('bootstrap 读取持久化的用户意愿', async () => {
    mockPrefs({ plugins: { enabled: { workbench: false }, uninstalled: [] } })
    seedCatalog()
    const store = usePluginStore()
    await store.bootstrap()
    expect(store.isEnabled('workbench')).toBe(false)
    expect(store.hydrated).toBe(true)
  })

  it('离线时 bootstrap 保持默认，不抛', async () => {
    ;(usePreferences as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockRejectedValue(new Error('offline')),
      patch: vi.fn(),
    })
    seedCatalog()
    const store = usePluginStore()
    await store.bootstrap()
    expect(store.isEnabled('workbench')).toBe(true)
  })

  it('toPluginViews 与 store 无关，是纯函数（视图模型不引入第二个真源）', () => {
    const views = toPluginViews([snap('a', ['widget.x'])])
    expect(views[0]).toMatchObject({ id: 'a', components: ['widget.x'] })
  })
})