/**
 * 插件契约单测（S7-1）—— schema 校验 / 状态聚合 / 拓扑排序 / 环检测。
 *
 * 这三块都是**纯逻辑**，所以能在不启动 Core 的情况下把语义钉死。S7-2 的扫盘与启停
 * 只是在这些函数外面包一层 I/O —— 语义错了这里就会红，不必等集成测。
 */
import { describe, expect, it } from 'vitest'
import {
  findPluginCycles,
  PluginManifestSchema,
  resolvePluginState,
  topoSortPlugins,
  type PluginManifest,
} from '../src/plugin-manifest'

/** 造一个合法清单（只写必填，其余用默认值 —— 这本身就在验证默认值） */
function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return PluginManifestSchema.parse({
    id: 'p',
    name: '插件',
    version: '1.0.0',
    ...over,
  })
}

describe('PluginManifest schema', () => {
  it('必填 id / name / version；缺一即拒', () => {
    expect(PluginManifestSchema.safeParse({ name: 'x', version: '1.0.0' }).success).toBe(false)
    expect(PluginManifestSchema.safeParse({ id: 'x', version: '1.0.0' }).success).toBe(false)
    expect(PluginManifestSchema.safeParse({ id: 'x', name: 'y' }).success).toBe(false)
    expect(PluginManifestSchema.safeParse({ id: 'x', name: 'y', version: '1' }).success).toBe(true)
  })

  it('services / components / capabilities / dependencies 缺省为空数组（不是 undefined）', () => {
    const m = manifest()
    expect(m.services).toEqual([])
    expect(m.components).toEqual([])
    expect(m.capabilities).toEqual([])
    expect(m.dependencies).toEqual([])
  })

  it('autoStart 缺省 true；显式 false 表示「装了但不自动起」', () => {
    expect(manifest().autoStart).toBe(true)
    expect(manifest({ autoStart: false }).autoStart).toBe(false)
  })

  it('dependency 的 optional 缺省 false（= 必需，缺了会 degraded）', () => {
    const m = manifest({ dependencies: [{ pluginId: 'models' } as never] })
    expect(m.dependencies[0]!.optional).toBe(false)
  })

  it('允许「无服务的插件」（只提供组件的内置插件）', () => {
    const m = manifest({ id: 'workbench', services: [], components: ['widget.settings'] })
    expect(m.services).toEqual([])
    expect(m.components).toEqual(['widget.settings'])
  })

  it('services / components 里的空串会被拒（slug 必须非空）', () => {
    expect(PluginManifestSchema.safeParse({ id: 'x', name: 'y', version: '1', services: [''] }).success).toBe(false)
    expect(PluginManifestSchema.safeParse({ id: 'x', name: 'y', version: '1', components: [''] }).success).toBe(false)
  })
})

describe('resolvePluginState · 状态聚合', () => {
  const ready = new Map([['session', 'ready']])
  const installed = new Set(['models', 'credentials'])

  it('服务全 ready + 依赖都在 → ready', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'] }),
      serviceStates: ready,
      installedPluginIds: installed,
    })
    expect(r.state).toBe('ready')
    expect(r.readyServiceCount).toBe(1)
  })

  it('缺必需依赖 → degraded（不是 failed）且指名缺谁', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'], dependencies: [{ pluginId: 'models', optional: false }] }),
      serviceStates: ready,
      installedPluginIds: new Set(), // models 没装
    })
    expect(r.state).toBe('degraded')
    expect(r.missingDependencies).toEqual(['models'])
    expect(r.reason).toContain('models')
  })

  it('缺可选依赖 → 不 degraded（可选就是可有可无）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'], dependencies: [{ pluginId: 'credentials', optional: true }] }),
      serviceStates: ready,
      installedPluginIds: new Set(), // credentials 没装，但它是可选的
    })
    expect(r.state).toBe('ready')
    expect(r.missingDependencies).toEqual([])
  })

  it('服务 failed → failed（比 degraded 严重）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'] }),
      serviceStates: new Map([['session', 'failed']]),
      installedPluginIds: installed,
    })
    expect(r.state).toBe('failed')
    expect(r.unhealthyServices).toEqual(['session'])
  })

  it('服务在但未 ready → degraded 且列出未就绪的服务', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session', 'loop'] }),
      serviceStates: new Map([['session', 'ready'], ['loop', 'starting']]),
      installedPluginIds: installed,
    })
    expect(r.state).toBe('degraded')
    expect(r.unhealthyServices).toEqual(['loop'])
    expect(r.readyServiceCount).toBe(1)
  })

  it('缺必需依赖 优先于 服务 failed（先说「你少装了东西」）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'], dependencies: [{ pluginId: 'models', optional: false }] }),
      serviceStates: new Map([['session', 'failed']]),
      installedPluginIds: new Set(),
    })
    expect(r.state).toBe('degraded')
    expect(r.missingDependencies).toEqual(['models'])
  })

  it('autoStart:false 且一个服务都没起 → stopped（不是 degraded：它没坏，是没开）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'], autoStart: false }),
      serviceStates: new Map(),
      installedPluginIds: installed,
    })
    expect(r.state).toBe('stopped')
  })

  it('autoStart:true 但服务一个都不在 → stopped（编排层还没起）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session'] }),
      serviceStates: new Map(),
      installedPluginIds: installed,
    })
    expect(r.state).toBe('stopped')
  })

  it('无服务的插件 → ready（它没东西要 ready，也不该 degraded）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: [], components: ['widget.settings'] }),
      serviceStates: new Map(),
      installedPluginIds: installed,
    })
    expect(r.state).toBe('ready')
  })

  it('stopped 的服务不算 unhealthy（用户主动停的不该被报成异常）', () => {
    const r = resolvePluginState({
      manifest: manifest({ services: ['session', 'loop'] }),
      serviceStates: new Map([['session', 'ready'], ['loop', 'stopped']]),
      installedPluginIds: installed,
    })
    expect(r.unhealthyServices).toEqual([])
  })
})

describe('topoSortPlugins · 依赖在前', () => {
  it('依赖排在被依赖者之前', () => {
    const sorted = topoSortPlugins([
      manifest({ id: 'chat-workbench', dependencies: [{ pluginId: 'models', optional: false }] }),
      manifest({ id: 'models' }),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['models', 'chat-workbench'])
  })

  it('多层依赖按层排开', () => {
    const sorted = topoSortPlugins([
      manifest({ id: 'c', dependencies: [{ pluginId: 'b', optional: false }] }),
      manifest({ id: 'b', dependencies: [{ pluginId: 'a', optional: false }] }),
      manifest({ id: 'a' }),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('缺失的依赖不阻断排序（那些插件靠状态聚合标 degraded）', () => {
    const sorted = topoSortPlugins([
      manifest({ id: 'chat-workbench', dependencies: [{ pluginId: 'not-installed', optional: false }] }),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['chat-workbench'])
  })

  it('输出稳定：同输入同顺序（按 id 排序后遍历，冒烟断言可预期）', () => {
    const input = [
      manifest({ id: 'z' }),
      manifest({ id: 'a' }),
      manifest({ id: 'm' }),
    ]
    expect(topoSortPlugins(input).map((m) => m.id)).toEqual(['a', 'm', 'z'])
    expect(topoSortPlugins(input).map((m) => m.id)).toEqual(topoSortPlugins(input).map((m) => m.id))
  })

  it('有环时不死循环（环由 findPluginCycles 报）', () => {
    const input = [
      manifest({ id: 'a', dependencies: [{ pluginId: 'b', optional: false }] }),
      manifest({ id: 'b', dependencies: [{ pluginId: 'a', optional: false }] }),
    ]
    expect(() => topoSortPlugins(input)).not.toThrow()
    expect(findPluginCycles(input).length).toBeGreaterThan(0)
  })
})

describe('findPluginCycles · 环检测', () => {
  it('无环 → 空', () => {
    const input = [
      manifest({ id: 'a' }),
      manifest({ id: 'b', dependencies: [{ pluginId: 'a', optional: false }] }),
    ]
    expect(findPluginCycles(input)).toEqual([])
  })

  it('两节点互依 → 报出一个环', () => {
    const input = [
      manifest({ id: 'a', dependencies: [{ pluginId: 'b', optional: false }] }),
      manifest({ id: 'b', dependencies: [{ pluginId: 'a', optional: false }] }),
    ]
    const cycles = findPluginCycles(input)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toContain('a')
    expect(cycles[0]).toContain('b')
  })

  it('三节点环 → 报出整条链', () => {
    const input = [
      manifest({ id: 'a', dependencies: [{ pluginId: 'c', optional: false }] }),
      manifest({ id: 'b', dependencies: [{ pluginId: 'a', optional: false }] }),
      manifest({ id: 'c', dependencies: [{ pluginId: 'b', optional: false }] }),
    ]
    const cycles = findPluginCycles(input)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.length).toBeGreaterThanOrEqual(3)
  })

  it('依赖指向不存在的插件不算环', () => {
    const input = [manifest({ id: 'a', dependencies: [{ pluginId: 'ghost', optional: false }] })]
    expect(findPluginCycles(input)).toEqual([])
  })
})
