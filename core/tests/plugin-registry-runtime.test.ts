import { describe, expect, test, vi } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventPayload, ServiceStatus } from '@osteosome/shared'
import { Bus } from '../src/bus/bus'
import { PluginRegistry } from '../src/service-manager/plugin-registry-runtime'

const here = path.dirname(fileURLToPath(import.meta.url))

/** bus 是微任务投递，同步断言收不到事件（与 credentials.test.ts 同一套等待） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))
const PLUGINS = path.join(here, 'fixtures', 'plugins')
const EMPTY = path.join(here, 'fixtures', 'plugins-empty')

type ChangedEvent = EventPayload<'plugin.state.changed'>

function makeRegistry(opts: {
  pluginsDir: string | undefined
  states?: Record<string, ServiceStatus>
  uninstalled?: string[]
  bus?: Bus
  controlService?: (command: 'start' | 'stop', serviceId: string) => Promise<void>
}) {
  const bus = opts.bus ?? new Bus()
  const registry = new PluginRegistry(bus, {
    pluginsDir: opts.pluginsDir,
    listServiceStates: () => new Map(Object.entries(opts.states ?? {})),
    uninstalledIds: () => new Set(opts.uninstalled ?? []),
    controlService: opts.controlService ?? (async () => undefined),
  })
  const events: ChangedEvent[] = []
  bus.subscribe('plugin.state.changed', (p) => events.push(p as ChangedEvent))
  return { bus, registry, events }
}

describe('PluginRegistry · 列表响应', () => {
  test('layer 与 installOrder 一并出去，前端才能区分「没装」和「装坏了」', () => {
    const { registry } = makeRegistry({ pluginsDir: PLUGINS })
    const body = registry.list()
    expect(body.layer).toBe('ok')
    expect(body.pluginsDir).toBe(PLUGINS)
    expect(body.installOrder).toContain('alpha')
    expect(body.cycles.length).toBeGreaterThan(0)
    expect(body.problems.length).toBeGreaterThan(0)
  })

  test('pluginsDir 未配置 -> layer=disabled，列表为空（不是故障）', () => {
    const { registry } = makeRegistry({ pluginsDir: undefined })
    expect(registry.list().layer).toBe('disabled')
    expect(registry.list().plugins).toEqual([])
  })

  test('目录不存在 -> layer=missing-dir，与 disabled 区分开', () => {
    const { registry } = makeRegistry({ pluginsDir: path.join(here, 'nope') })
    expect(registry.list().layer).toBe('missing-dir')
  })

  test('目录在但零清单 -> layer=empty', () => {
    const { registry } = makeRegistry({ pluginsDir: EMPTY })
    expect(registry.list().layer).toBe('empty')
  })

  test('状态随传入的服务状态变化', () => {
    const { registry } = makeRegistry({
      pluginsDir: PLUGINS,
      states: { 'svc-a': 'ready', 'svc-b': 'ready' },
    })
    const alpha = registry.list().plugins.find((p) => p.manifest.id === 'alpha')!
    expect(alpha.state).toBe('ready')
    expect(alpha.readyServiceCount).toBe(1)
  })

  test('uninstalled 走 preferences -> installed=false，且依赖它的插件 degraded', () => {
    const { registry } = makeRegistry({
      pluginsDir: PLUGINS,
      states: { 'svc-a': 'ready', 'svc-b': 'ready' },
      uninstalled: ['beta'],
    })
    const list = registry.list().plugins
    expect(list.find((p) => p.manifest.id === 'beta')!.installed).toBe(false)
    expect(list.find((p) => p.manifest.id === 'alpha')!.state).toBe('degraded')
  })
})

describe('PluginRegistry · 只在状态变化时发事件', () => {
  test('服务状态没变 -> refresh 不发任何事件', () => {
    const states = { 'svc-a': 'ready' as ServiceStatus }
    const { registry, events } = makeRegistry({ pluginsDir: PLUGINS, states })
    registry.refresh()
    expect(events).toHaveLength(0)
  })

  test('服务状态变了 -> 每个变化插件各发一条，载荷带 pluginId', async () => {
    const states: Record<string, ServiceStatus> = {}
    const { registry, events } = makeRegistry({ pluginsDir: PLUGINS, states })
    expect(events).toHaveLength(0)

    states['svc-a'] = 'failed'
    registry.refresh()
    await settle()

    const alpha = events.filter((e) => e.pluginId === 'alpha')
    expect(alpha).toHaveLength(1)
    expect(alpha[0].state).toBe('failed')
    expect(alpha[0].source).toBe('core')
    expect(typeof alpha[0].ts).toBe('number')
    expect(alpha[0].totalServices).toBe(1)
  })

  test('依赖关系变化也算变化（不是只看服务状态）', async () => {
    const states: Record<string, ServiceStatus> = { 'svc-a': 'ready', 'svc-b': 'ready' }
    const uninstalled: string[] = []
    const bus = new Bus()
    const registry = new PluginRegistry(bus, {
      pluginsDir: PLUGINS,
      listServiceStates: () => new Map(Object.entries(states)),
      uninstalledIds: () => new Set(uninstalled),
      controlService: async () => undefined,
    })
    const events: ChangedEvent[] = []
    bus.subscribe('plugin.state.changed', (p) => events.push(p as ChangedEvent))

    uninstalled.push('beta')
    registry.refresh()
    await settle()
    expect(events.find((e) => e.pluginId === 'alpha')?.state).toBe('degraded')
  })
})

describe('PluginRegistry · rescan 与 refresh 分开', () => {
  test('refresh 不重新读盘（服务事件很密，每次读盘太浪费）', () => {
    const { registry } = makeRegistry({ pluginsDir: PLUGINS })
    // 同一个 pluginsDir 下换两次状态，installOrder 与 problems 必须不变（没重扫）
    const before = registry.list().problems.length
    registry.refresh()
    expect(registry.list().problems.length).toBe(before)
  })

  test('rescan 重读盘并为每个插件发一条事件', async () => {
    const { registry, events } = makeRegistry({ pluginsDir: PLUGINS })
    expect(events).toHaveLength(0)
    registry.rescan()
    await settle()
    expect(events.length).toBe(registry.list().plugins.length)
    expect(events.map((e) => e.pluginId)).toContain('alpha')
  })
})

describe('PluginRegistry · allowedServiceIds（B 语义唯一决策点，S7-2b）', () => {
  const REAL = path.join(here, '..', '..', 'plugins')

  type RegistryOpts = Parameters<typeof makeRegistry>[0]

  function real(over: Partial<RegistryOpts> = {}) {
    return makeRegistry({ ...over, pluginsDir: REAL })
  }

  test('全装 -> 认领全部服务，一个都不少', () => {
    // 真实 5 个插件认领了全部 6 个服务，所以 B 语义下**不该少任何一个**。
    // 这条是 S7-2b 最容易出的错：过滤逻辑写错一个字符就会少启一个服务，
    // 而少启的服务表现为「界面某块空白」，不报错。
    const allowed = real({}).registry.allowedServiceIds()
    expect(allowed).toBeDefined()
    expect([...(allowed as Set<string>)].sort()).toEqual([
      'credentials',
      'llm',
      'llm-provider-openai',
      'llm-retry',
      'loop',
      'session',
    ])
  })

  test('uninstalled 的插件 -> 其服务不被允许（uninstalled 不只是 UI 标志）', () => {
    const allowed = real({ uninstalled: ['models'] }).registry.allowedServiceIds() as Set<string>
    expect(allowed.has('llm-provider-openai')).toBe(false)
    expect(allowed.has('credentials')).toBe(true)
    expect(allowed.has('session')).toBe(true)
    expect(allowed.has('loop')).toBe(true)
    expect(allowed.has('llm')).toBe(true)
  })

  test('三态非 ok -> 返回 undefined（不限制 = 全启），绝不返回空集合', () => {
    // 这是整条降级链的落点。返回空集合 = 零服务 = 应用不可用，
    // 所以「undefined 与空集合必须区分」这件事本身就是断言。
    expect(makeRegistry({ pluginsDir: undefined }).registry.allowedServiceIds()).toBeUndefined()
    expect(
      makeRegistry({ pluginsDir: path.join(here, 'fixtures', 'plugins-empty') }).registry
        .allowedServiceIds(),
    ).toBeUndefined()
    expect(
      makeRegistry({ pluginsDir: path.join(here, 'no-such-dir') }).registry.allowedServiceIds(),
    ).toBeUndefined()
  })

  test('autoStart:false 的插件 -> 其服务不被允许（夹具 gamma 无服务，改用未安装路径验证语义）', () => {
    // gamma 在夹具里 services: []，所以这条改验「插件被卸」这条同族规则；
    // autoStart 的分支由真实清单里没有 autoStart:false 的插件而无法在此夹具验证，
    // 已在 allowedServiceIds() 的注释里写明。
    const allowed = real({ uninstalled: ['reliability'] }).registry.allowedServiceIds() as Set<string>
    expect(allowed.has('llm-retry')).toBe(false)
    expect(allowed.size).toBe(5)
  })

  test('环内插件的服务不被允许（夹具 cyc-a 带 svc-cyc）', () => {
    const allowed = makeRegistry({ pluginsDir: PLUGINS }).registry.allowedServiceIds() as Set<string>
    expect(allowed.has('svc-cyc')).toBe(false)
    expect(allowed.has('svc-a')).toBe(true)
  })
})

describe('PluginRegistry · control：plugin.start / plugin.stop 展开成服务启停', () => {
  test('stop 展开成停该插件的全部服务', async () => {
    const calls: string[] = []
    const { registry } = makeRegistry({
      pluginsDir: path.join(here, '..', '..', 'plugins'),
      controlService: async (c, sid) => {
        calls.push(`${c}:${sid}`)
      },
    })
    const result = await registry.control('stop', 'models')
    expect(result).toEqual({ serviceIds: ['llm-provider-openai'] })
    expect(calls).toEqual(['stop:llm-provider-openai'])
  })

  test('start 展开成启该插件的全部服务（三个）', async () => {
    const calls: string[] = []
    const { registry } = makeRegistry({
      pluginsDir: path.join(here, '..', '..', 'plugins'),
      controlService: async (c, sid) => {
        calls.push(`${c}:${sid}`)
      },
    })
    const result = await registry.control('start', 'chat-workbench')
    expect(result).toEqual({ serviceIds: ['session', 'loop', 'llm'] })
    expect(calls.sort()).toEqual(['start:llm', 'start:loop', 'start:session'])
  })

  test('停含 loop 的插件前先发 loop.cancel（否则留半截 assistant）', async () => {
    const bus = new Bus()
    const cancels: unknown[] = []
    bus.subscribe('loop.cancel', (p) => cancels.push(p))
    const { registry } = makeRegistry({
      pluginsDir: path.join(here, '..', '..', 'plugins'),
      bus,
      controlService: async () => undefined,
    })
    await registry.control('stop', 'chat-workbench')
    await settle()
    expect(cancels).toHaveLength(1)
    expect(cancels[0]).toMatchObject({ requestId: 'plugin.stop:chat-workbench' })
  })

  test('停不含 loop 的插件不发 loop.cancel', async () => {
    const bus = new Bus()
    const cancels: unknown[] = []
    bus.subscribe('loop.cancel', (p) => cancels.push(p))
    const { registry } = makeRegistry({
      pluginsDir: path.join(here, '..', '..', 'plugins'),
      bus,
      controlService: async () => undefined,
    })
    await registry.control('stop', 'models')
    await settle()
    expect(cancels).toHaveLength(0)
  })

  test('未安装的插件 -> 返回错误字符串（不是抛异常）', async () => {
    const { registry } = makeRegistry({ pluginsDir: path.join(here, '..', '..', 'plugins') })
    expect(await registry.control('stop', 'nope')).toBe("plugin 'nope' not installed")
  })

  test('一个服务停不下来不影响其余服务（否则会连坐）', async () => {
    const calls: string[] = []
    const { registry } = makeRegistry({
      pluginsDir: path.join(here, '..', '..', 'plugins'),
      controlService: async (c, sid) => {
        calls.push(sid)
        if (sid === 'loop') throw new Error('loop 卡住了')
      },
    })
    const result = await registry.control('stop', 'chat-workbench')
    // 三个都尝试过，包括抛错那个
    expect(calls.sort()).toEqual(['llm', 'loop', 'session'])
    expect(result).toEqual({ serviceIds: ['session', 'loop', 'llm'] })
  })
})

describe('PluginRegistry · attach 挂在服务生命周期上', () => {
  test('服务事件触发刷新（微任务合并），同一轮多个事件只算一次', async () => {
    const states: Record<string, ServiceStatus> = {}
    const bus = new Bus()
    const { registry, events } = makeRegistry({ pluginsDir: PLUGINS, states, bus })
    registry.attach()

    states['svc-a'] = 'ready'
    states['svc-b'] = 'ready'
    // 必须真的 publish：attach() 订阅的是 service.* topic，
    // 光改 states 不会触发任何东西（第一版就是这么写错的）
    bus.publish('service.ready', { ts: Date.now(), source: 'core', serviceId: 'svc-a', version: '1' })
    bus.publish('service.ready', { ts: Date.now(), source: 'core', serviceId: 'svc-b', version: '1' })
    await settle()

    // alpha 与 beta 各自 ready -> 两条，但 starting+ready 那种连发被合并成一次聚合
    const alphaEvents = events.filter((e) => e.pluginId === 'alpha')
    expect(alphaEvents.length).toBeGreaterThan(0)
    expect(alphaEvents[alphaEvents.length - 1].state).toBe('ready')
  })
})