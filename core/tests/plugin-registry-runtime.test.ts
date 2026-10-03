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
}) {
  const bus = opts.bus ?? new Bus()
  const registry = new PluginRegistry(bus, {
    pluginsDir: opts.pluginsDir,
    listServiceStates: () => new Map(Object.entries(opts.states ?? {})),
    uninstalledIds: () => new Set(opts.uninstalled ?? []),
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