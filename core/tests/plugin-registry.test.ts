import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServiceStatus } from '@osteosome/shared'
import { loadPluginLayer, scanPlugins, snapshotPlugins } from '../src/service-manager/plugin-registry'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, 'fixtures')
/** 仓库根下的真实 plugins/ 与 services/ —— S7-5 落的就是它 */
const REPO_ROOT = path.join(here, '..', '..')
const REAL_PLUGINS = path.join(REPO_ROOT, 'plugins')
const PLUGINS = path.join(FIXTURES, 'plugins')
const EMPTY = path.join(FIXTURES, 'plugins-empty')

/** 把所有匹配的原因拼起来 —— 不止一处清单可能命中同一句（例如多个插件都指向不存在的服务） */
function reasonFor(scan: ReturnType<typeof scanPlugins>, fragment: string): string {
  return scan.problems
    .filter((p) => p.reason.includes(fragment))
    .map((p) => p.reason)
    .join(' | ')
}

/** 夹具里全部被声明过的服务 id（含故意的坏引用） */
const ALL_FIXTURE_SERVICES = ['svc-a', 'svc-b', 'svc-cyc', 'svc-does-not-exist']

describe('scanPlugins · 三态', () => {
  test('pluginsDir 未配置 -> disabled，不算问题（测试与显式意图，不是手滑）', () => {
    for (const dir of [undefined, '']) {
      const scan = scanPlugins(dir)
      expect(scan.status).toBe('disabled')
      expect(scan.pluginsDir).toBeNull()
      expect(scan.plugins).toEqual([])
      expect(scan.problems).toEqual([])
    }
  })

  test('目录不存在 -> missing-dir（不塞 problem：status 已经说完了，见 loadPluginLayer）', () => {
    const scan = scanPlugins(path.join(FIXTURES, 'no-such-dir'))
    expect(scan.status).toBe('missing-dir')
    expect(scan.pluginsDir).toBe(path.join(FIXTURES, 'no-such-dir'))
    expect(scan.plugins).toEqual([])
    expect(scan.problems).toEqual([])
  })

  test('目录在但零个清单 -> empty（漏 S7-5 的现场特征）', () => {
    const scan = scanPlugins(EMPTY)
    expect(scan.status).toBe('empty')
    expect(scan.ids).toEqual([])
  })

  test('有清单 -> ok', () => {
    expect(scanPlugins(PLUGINS).status).toBe('ok')
  })
})

describe('scanPlugins · 不抛错（与 loadServices 的关键区别）', () => {
  test('一个坏 plugin.json 不影响其余插件加载', () => {
    const scan = scanPlugins(PLUGINS)
    // 坏 JSON、schema 不合格、环、重复 id 全在里面，但好插件照样读出来了
    expect(scan.ids).toContain('alpha')
    expect(scan.ids).toContain('beta')
    expect(scan.ids).toContain('gamma')
    expect(scan.problems.length).toBeGreaterThan(0)
  })

  test('坏 JSON 进 problems，不抛', () => {
    expect(reasonFor(scanPlugins(PLUGINS), 'parse failed')).toBeTruthy()
  })

  test('schema 不合格（缺 version）进 problems，格式与 manifest 校验一致', () => {
    const reason = reasonFor(scanPlugins(PLUGINS), 'schema invalid')
    expect(reason).toBeTruthy()
    expect(reason).toContain('version')
  })

  test('环不抛错，环内插件留在 plugins 里让用户看见（不能凭空消失）', () => {
    const scan = scanPlugins(PLUGINS)
    expect(scan.cycles.length).toBeGreaterThan(0)
    const inCycle = scan.cycles.flat()
    expect(inCycle).toContain('cyc-a')
    expect(inCycle).toContain('cyc-b')
    expect(scan.ids).toContain('cyc-a')
    expect(scan.ids).toContain('cyc-b')
  })

  test('环内插件**不进 installOrder** —— 否则 S7-2b 会瞎猜一个顺序启它', () => {
    const order = scanPlugins(PLUGINS).installOrder
    expect(order).not.toContain('cyc-a')
    expect(order).not.toContain('cyc-b')
    // 好插件照常在安装顺序里，且依赖在前
    expect(order).toContain('gamma')
    expect(order.indexOf('gamma')).toBeLessThan(order.indexOf('beta'))
    expect(order.indexOf('beta')).toBeLessThan(order.indexOf('alpha'))
  })

  test('展示排序与安装顺序是**两件事**：环内成员排在最后但不进安装顺序', () => {
    const scan = scanPlugins(PLUGINS)
    // plugins 的顺序 = 安装顺序在前、环内成员稳定排在最后
    expect(scan.ids.slice(-2)).toEqual(['cyc-a', 'cyc-b'])
    expect(scan.installOrder).not.toContain('cyc-a')
  })

  test('重复 id：只留第一个，第二个进 problems', () => {
    const scan = scanPlugins(PLUGINS)
    expect(scan.ids.filter((id) => id === 'twin')).toHaveLength(1)
    expect(reasonFor(scan, 'duplicate plugin id')).toContain('twin')
  })
})

describe('scanPlugins · 拓扑序', () => {
  test('依赖在前：gamma -> beta -> alpha', () => {
    const order = scanPlugins(PLUGINS).ids
    expect(order.indexOf('gamma')).toBeLessThan(order.indexOf('beta'))
    expect(order.indexOf('beta')).toBeLessThan(order.indexOf('alpha'))
  })

  test('可选依赖缺失不阻断排序（靠状态聚合标 degraded，不是靠排不进去）', () => {
    // beta 依赖 absent（optional），但 beta 确实排出来了
    expect(scanPlugins(PLUGINS).ids).toContain('beta')
  })

  test('目录名与 id 不一致时以 id 为准，但留痕', () => {
    const scan = scanPlugins(PLUGINS)
    expect(reasonFor(scan, '!= directory name')).toBeTruthy()
  })
})

describe('scanPlugins · services 交叉校验', () => {
  test('给了 knownServiceIds 时，指向不存在服务的 id 被拦下', () => {
    const scan = scanPlugins(PLUGINS, new Set(['svc-a', 'svc-b']))
    const reason = reasonFor(scan, 'services 指向不存在的服务')
    expect(reason).toContain('svc-does-not-exist')
    expect(reason).toContain('svc-cyc')
  })

  test('不给 knownServiceIds 时不做这项校验（S7-2b 之前拿不到服务清单）', () => {
    expect(reasonFor(scanPlugins(PLUGINS), 'services 指向不存在的服务')).toBe('')
  })

  test('全部服务都存在时不报这项', () => {
    const scan = scanPlugins(PLUGINS, new Set(ALL_FIXTURE_SERVICES))
    expect(reasonFor(scan, 'services 指向不存在的服务')).toBe('')
  })
})

describe('snapshotPlugins · 状态聚合吃真实服务状态', () => {
  const scan = scanPlugins(PLUGINS)

  function snap(id: string, opts: { states?: Record<string, ServiceStatus>; uninstalled?: string[] } = {}) {
    const found = snapshotPlugins(scan, {
      serviceStates: new Map(Object.entries(opts.states ?? {}) as [string, ServiceStatus][]),
      uninstalledIds: opts.uninstalled ? new Set(opts.uninstalled) : undefined,
    }).find((p) => p.manifest.id === id)
    if (!found) throw new Error(`fixture 缺插件 ${id}`)
    return found
  }

  test('服务全 ready 且依赖齐全 -> ready', () => {
    expect(snap('beta', { states: { 'svc-b': 'ready' } }).state).toBe('ready')
  })

  test('服务 failed -> failed', () => {
    expect(snap('alpha', { states: { 'svc-a': 'failed' } }).state).toBe('failed')
  })

  test('gamma 无服务且 autoStart:false -> stopped（不是 degraded）', () => {
    expect(snap('gamma').state).toBe('stopped')
  })

  test('必需依赖齐全时 missingDependencies 为空', () => {
    const alpha = snap('alpha', { states: { 'svc-a': 'ready' } })
    expect(alpha.missingDependencies).toEqual([])
  })

  test('**被卸掉的插件等于依赖缺失** -> 依赖它的插件 degraded', () => {
    // beta 没了，依赖它的 alpha 就该 degraded —— uninstalled 不只是 UI 标志
    const alpha = snap('alpha', { states: { 'svc-a': 'ready' }, uninstalled: ['beta'] })
    expect(alpha.state).toBe('degraded')
    expect(alpha.missingDependencies).toEqual(['beta'])
    expect(alpha.installed).toBe(true)
  })

  test('缺可选依赖只进 missingOptional，不影响 state', () => {
    const beta = snap('beta', { states: { 'svc-b': 'ready' } })
    expect(beta.missingOptional).toContain('absent')
    expect(beta.missingDependencies).toEqual([])
    expect(beta.state).toBe('ready')
  })

  test('serviceStates 原样映射：未在跑的服务是 undefined 而非 stopped', () => {
    expect(snap('alpha', { states: { 'svc-a': 'ready' } }).serviceStates).toEqual({ 'svc-a': 'ready' })
    expect(snap('gamma').serviceStates).toEqual({})
  })

  test('installed 由 preferences.uninstalled 决定（目录存在即已装）', () => {
    expect(scanPlugins(PLUGINS).ids.length).toBeGreaterThan(0)
    expect(snap('beta').installed).toBe(true)
    expect(snap('beta', { uninstalled: ['beta'] }).installed).toBe(false)
    expect(snap('alpha', { uninstalled: ['beta'] }).installed).toBe(true)
  })

  test('unhealthyServices / readyServiceCount 原样透出（详情窗要写「N/M」）', () => {
    const alpha = snap('alpha', { states: { 'svc-a': 'ready' } })
    expect(alpha.unhealthyServices).toEqual([])
    expect(alpha.readyServiceCount).toBe(1)
    const beta = snap('beta', { states: { 'svc-b': 'starting' } })
    expect(beta.state).toBe('degraded')
    expect(beta.unhealthyServices).toEqual(['svc-b'])
    expect(beta.readyServiceCount).toBe(0)
  })

  test('环内插件 installed=true（目录在），但因必需依赖无法满足而 degraded', () => {
    const cyc = snap('cyc-a')
    // 目录在 -> installed 为真。这与「能不能被启」无关
    expect(cyc.installed).toBe(true)
    // 但它依赖的 cyc-b 同在环里、永远起不来 -> 不算依赖满足
    expect(cyc.state).toBe('degraded')
    expect(cyc.missingDependencies).toEqual(['cyc-b'])
  })

  test('环内插件**不会**让依赖它的插件以为一切正常（双向都 degraded）', () => {
    expect(snap('cyc-b').state).toBe('degraded')
    expect(snap('cyc-b').missingDependencies).toEqual(['cyc-a'])
    expect(snap('cyc-b').installed).toBe(true)
  })

  test('无服务、无依赖、autoStart 缺省 -> ready（S7-1「workbench 那种」定案）', () => {
    // twin: services [] / dependencies [] / autoStart 缺省 true
    expect(snap('twin').state).toBe('ready')
  })
})

describe('真实 plugins/（S7-5 落的那份划分，P1 起服务在插件里）', () => {
  /** 真实服务 id —— P1 之后要从插件目录两级扫（`plugins/<id>/services/<sid>/`） */
  function realServiceIds(): Set<string> {
    const out = new Set<string>()
    for (const plugin of readdirSync(REAL_PLUGINS, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue
      const root = path.join(REAL_PLUGINS, plugin.name, 'services')
      if (!existsSync(root)) continue
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(path.join(root, e.name, 'service.json'))) out.add(e.name)
      }
    }
    return out
  }

  test('扫得出 7 个插件，且零问题零环', () => {
    const scan = scanPlugins(REAL_PLUGINS, realServiceIds())
    expect(scan.status).toBe('ok')
    expect(scan.ids.sort()).toEqual([
      'agents',
      'chat-workbench',
      'models',
      'reliability',
      'skills',
      'tools',
      'workbench',
    ])
    expect(scan.problems).toEqual([])
    expect(scan.cycles).toEqual([])
  })

  test('**每个服务都被某个插件认领** —— 漏一个，S7-2b 就会漏 spawn 它', () => {
    // 这是 B 语义最直接的翻车方式：服务存在于 services/ 但没有任何插件声明它，
    // 于是切语义之后它静默不启动了。所以拿「认领数 == 服务数」当断言。
    const scan = scanPlugins(REAL_PLUGINS, realServiceIds())
    const claimed = new Set(scan.plugins.flatMap((p) => p.manifest.services))
    const unclaimed = [...realServiceIds()].filter((id) => !claimed.has(id))
    expect(unclaimed).toEqual([])
    expect(claimed.size).toBe(realServiceIds().size)
  })

  test('安装顺序满足依赖：models -> chat-workbench -> reliability', () => {
    // 凭证能力位退休后依赖图浅了一层：models 不再依赖 credentials 插件
    // （密钥与接入清单都归它自己，见 docs/插件化架构优化.html §4）。
    const order = scanPlugins(REAL_PLUGINS, realServiceIds()).installOrder
    expect(order.indexOf('models')).toBeLessThan(order.indexOf('chat-workbench'))
    expect(order.indexOf('chat-workbench')).toBeLessThan(order.indexOf('reliability'))
  })

  test('workbench 无服务且无依赖 -> 恒 ready（不会拖累别人）', () => {
    const scan = scanPlugins(REAL_PLUGINS, realServiceIds())
    const wb = snapshotPlugins(scan, { serviceStates: new Map() }).find(
      (p) => p.manifest.id === 'workbench',
    )!
    expect(wb.state).toBe('ready')
    expect(wb.manifest.dependencies).toEqual([])
  })

  test('全部服务 ready 时，7 个插件全 ready', () => {
    const states = new Map<string, ServiceStatus>(
      [...realServiceIds()].map((id) => [id, 'ready' as ServiceStatus]),
    )
    const snapshots = snapshotPlugins(scanPlugins(REAL_PLUGINS, realServiceIds()), {
      serviceStates: states,
    })
    expect(snapshots.map((p) => [p.manifest.id, p.state])).toEqual(
      expect.arrayContaining([
        ['workbench', 'ready'],
        ['models', 'ready'],
        ['chat-workbench', 'ready'],
        ['reliability', 'ready'],
        ['agents', 'ready'],
        ['skills', 'ready'],
        ['tools', 'ready'],
      ]),
    )
  })

  test('卸掉 models -> 只有 chat-workbench 与 reliability 受影响（依赖图真的分了三层）', () => {
    const all = [...realServiceIds()]
    // 按 S7-2b 之后的现实建模：被卸的插件，它的服务也不会在跑
    const states = new Map<string, ServiceStatus>(
      all.filter((id) => id !== 'llm-provider-openai').map((id) => [id, 'ready' as ServiceStatus]),
    )
    const snapshots = snapshotPlugins(scanPlugins(REAL_PLUGINS, realServiceIds()), {
      serviceStates: states,
      uninstalledIds: new Set(['models']),
    })
    const byId = new Map(snapshots.map((p) => [p.manifest.id, p]))
    // 被卸的插件自己是 stopped（它的服务也不会被 spawn），不是 degraded ——
    // degraded 是「还装着但缺东西」，那说的是下面 chat-workbench 那种情况
    expect(byId.get('models')!.state).toBe('stopped')
    // 依赖它的 chat-workbench degraded —— 这正是 B 语义要展示的「你少装了东西」
    expect(byId.get('chat-workbench')!.state).toBe('degraded')
    expect(byId.get('chat-workbench')!.missingDependencies).toEqual(['models'])
    expect(byId.get('workbench')!.state).toBe('ready')
    // reliability 仍 ready：它依赖的是 chat-workbench「已安装」，不是「已健康」。
    // 依赖传播 degraded 是**刻意不做**的 —— 那会让一处故障沿依赖树扩散，
    // 且让「谁真正缺东西」变得要看整张图。S7-1 定案：依赖满足 = 装了就满足。
    expect(byId.get('reliability')!.state).toBe('ready')
  })

  test('已知缺口：S7-2b 之前，uninstalled 的插件若服务还在跑，仍报 ready', () => {
    // resolvePluginState 只看**服务真实状态**，不看「插件自己被卸了」。
    // 所以在这个人为造的不一致世界里（服务照跑、插件已卸），它报 ready。
    //
    // 刻意把这条钉住而不是「顺手修掉」：S7-2b 之后被卸插件的服务不会被 spawn，
    // 这个状态就自然不存在了。真正的修法在 2b（把启停与 installed 绑起来），
    // 而不是现在给 shared 加一个它并不需要的概念。
    const states = new Map<string, ServiceStatus>(
      [...realServiceIds()].map((id) => [id, 'ready' as ServiceStatus]),
    )
    const models = snapshotPlugins(scanPlugins(REAL_PLUGINS, realServiceIds()), {
      serviceStates: states,
      uninstalledIds: new Set(['models']),
    }).find((p) => p.manifest.id === 'models')!
    expect(models.installed).toBe(false)
    expect(models.state).toBe('ready')
  })
})

describe('loadPluginLayer', () => {
  test('返回 scan 与 snapshots 两份，快照顺序即拓扑序', () => {
    const { scan: s, snapshots } = loadPluginLayer({
      pluginsDir: PLUGINS,
      serviceStates: new Map([['svc-a', 'ready' as ServiceStatus]]),
    })
    expect(s.status).toBe('ok')
    expect(snapshots.map((p) => p.manifest.id)).toEqual(s.ids)
  })

  test('disabled 不产生任何问题', () => {
    const { scan, snapshots } = loadPluginLayer({
      pluginsDir: undefined,
      serviceStates: new Map(),
    })
    expect(scan.status).toBe('disabled')
    expect(snapshots).toEqual([])
  })
})