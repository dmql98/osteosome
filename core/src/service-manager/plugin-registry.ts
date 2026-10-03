/**
 * 插件清单扫描（S7-2a：只读）
 *
 * 职责：扫 `plugins/<id>/plugin.json` → zod 校验 → **先跑环检测** → 拓扑排序 →
 *      把真实服务状态喂进 `resolvePluginState` 聚合出对外快照。
 *
 * ## 与 `loadServices` 的关键区别：不抛错
 *
 * `loadServices` 是「全成功或抛 ManifestError」—— 因为 `services/` 是**代码**，
 * 里面坏一个就是部署坏了，不该装作没事。
 *
 * 插件层反过来：清单是**数据**，拷目录进来就可能不合法，而且插件坏掉
 * 不该让 Core 起不来。所以这里把每个问题收进 `problems`，其余照常返回。
 * 这也是三态降级保护（S7-2b）要读的数据形状。
 *
 * ## 本文件是只读的
 *
 * 「未安装插件的服务不 spawn」是 **S7-2b**。这里不碰 `manager.start()`，
 * 所以无论扫出 0 个、1 个还是 50 个插件，Core 的启动行为与 S7-1 之前完全一致。
 * 这一点是刻意的：S7-2a 零风险，可以独立回归。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  findPluginCycles,
  PluginManifestSchema,
  resolvePluginState,
  topoSortPlugins,
  type PluginManifest,
  type PluginState,
} from '@osteosome/shared'
import type { ServiceStatus } from '@osteosome/shared'
import { logger } from '../logger'

/** 插件层是否可用，以及为什么不可用 —— 三态降级保护（S7-2b）读这个 */
export type PluginLayerStatus =
  /** `pluginsDir` 未配置（`--plugins none` / `OST_PLUGINS=none`）→ 有意关掉，不告警 */
  | 'disabled'
  /** 配了 `pluginsDir` 但目录不存在 → 疑似路径写错，要告警 */
  | 'missing-dir'
  /** 目录在，但零个清单 → 疑似漏了 S7-5，要告警 */
  | 'empty'
  /** 正常读到清单（哪怕其中几个有问题） */
  | 'ok'

/** 扫盘期发现的一个问题。**单个**问题不影响其余插件加载 */
export interface PluginProblem {
  /** 目录名，或 `<pluginsDir>`（目录级问题） */
  where: string
  /** 人能读懂的原因，直接进日志与 `/api/plugins` 的 problems 字段 */
  reason: string
  /** 目录级问题（如整目录不可读）没有 id */
  pluginId?: string
}

export interface LoadedPlugin {
  manifest: PluginManifest
  /** `plugins/<dir>/` */
  dir: string
}

export interface PluginScan {
  /** 未配置时为 null */
  pluginsDir: string | null
  status: PluginLayerStatus
  /**
   * 全部合法清单（含环内成员），按「安装顺序在前、环内成员在后」排。
   *
   * 环内成员**保留在这里**是有意的：它们装了、也该让用户在界面看见（否则表现为
   * 「插件凭空消失」，比「这两个插件坏了」更难排查）。它们只是不在 `installOrder` 里。
   */
  plugins: LoadedPlugin[]
  problems: PluginProblem[]
  /** 依赖环，每条是一个插件 id 列表。空 = 无环 */
  cycles: string[][]
  /** 全部已加载插件 id（= `plugins` 的 id，按序） */
  ids: string[]
  /**
   * 依赖在前的启动顺序，**环内成员不在其中**。
   *
   * S7-2b 只按这个顺序 spawn。若把环内成员混进来，就得随便挑个顺序启 ——
   * 它们会各自等对方，最后一起超时。所以这里宁可少列，也不给一个假的顺序。
   */
  installOrder: string[]
}

/**
 * 一个插件的对外快照 —— `/api/plugins` 返回的就是这个。
 *
 * 注意这里**原样带出 `manifest`**，前端不需要另一份形状：
 * 组件 / 能力位 / 依赖都是给人看的，直接给原始声明比再映射一次更少出错。
 */
export interface PluginSnapshot {
  manifest: PluginManifest
  /** 目录存在即已安装，再叠加 `preferences.plugins.uninstalled` 表达「装了但被我卸了」 */
  installed: boolean
  state: PluginState
  /** 人能读懂的原因（degraded / failed 时有值），UI 可直接显示 */
  reason: string
  /** 必需依赖中未被满足的（`state` 为 degraded 时看这里） */
  missingDependencies: string[]
  /** 可选依赖中未被满足的 —— **不影响 state**，只作展示 */
  missingOptional: string[]
  /** 未 ready / failed 的服务 id */
  unhealthyServices: string[]
  /** ready 服务数（不是 ready 的插件也展示，供详情窗写「N/M」） */
  readyServiceCount: number
  /** 声明的服务当前真实状态。`undefined` = 该服务未在跑（未安装 / 未启动） */
  serviceStates: Record<string, ServiceStatus | undefined>
}

/**
 * 扫 `pluginsDir`。
 *
 * @param pluginsDir 插件目录；`undefined` / 空串表示**插件层未配置**
 * @param knownServiceIds 已加载的服务 id。给了就校验 `manifest.services` 里有没有指向
 *   不存在的服务（打错字的服务 id 会静默地什么都不做 —— 这类错值得当场拦住）。
 *   S7-2b 接上之后这个参数是必需的。
 */
export function scanPlugins(pluginsDir: string | undefined, knownServiceIds?: ReadonlySet<string>): PluginScan {
  if (pluginsDir === undefined || pluginsDir === '') {
    return { pluginsDir: null, status: 'disabled', plugins: [], problems: [], cycles: [], ids: [], installOrder: [] }
  }
  if (!existsSync(pluginsDir)) {
    // 刻意**不**往 problems 里塞一条：`status: 'missing-dir'` + `pluginsDir` 已经
    // 完整表达了，loadPluginLayer 也会为此专门告警一次。再塞一条只会让同件事
    // 在日志里出现两遍（实测过），而 `/api/plugins` 的消费者读 status 就够。
    return {
      pluginsDir,
      status: 'missing-dir',
      plugins: [],
      problems: [],
      cycles: [],
      ids: [],
      installOrder: [],
    }
  }

  const problems: PluginProblem[] = []
  const loaded: LoadedPlugin[] = []

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(pluginsDir, entry.name, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      problems.push({ where: entry.name, reason: `plugin.json parse failed: ${String(err)}` })
      continue
    }

    const parsed = PluginManifestSchema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
      problems.push({ where: entry.name, reason: `schema invalid: ${detail}` })
      continue
    }
    const manifest = parsed.data

    // 目录名与 id 不一致：id 才是身份，所以以 id 为准，但要留痕 —— 它说明拷目录时
    // 有人改过 id，最常见的后果是依赖方按旧 id 找不到它。
    if (manifest.id !== entry.name) {
      problems.push({
        where: entry.name,
        pluginId: manifest.id,
        reason: `id '${manifest.id}' != directory name '${entry.name}'（以 id 为准）`,
      })
    }
    if (knownServiceIds) {
      const unknown = manifest.services.filter((s) => !knownServiceIds.has(s))
      if (unknown.length > 0) {
        problems.push({
          where: entry.name,
          pluginId: manifest.id,
          reason: `services 指向不存在的服务: ${unknown.join(', ')}`,
        })
      }
    }
    loaded.push({ manifest, dir: path.join(pluginsDir, entry.name) })
  }

  // 重复 id：两个目录声明同一个 id。必须在拓扑排序**之前**检出 —— 否则后一个会
  // 静默覆盖前一个，而依赖图算出来的顺序完全看不出有人重名。
  const byId = new Map<string, LoadedPlugin>()
  const unique: LoadedPlugin[] = []
  for (const p of loaded) {
    const prev = byId.get(p.manifest.id)
    if (prev) {
      problems.push({
        where: path.basename(p.dir),
        pluginId: p.manifest.id,
        reason: `duplicate plugin id '${p.manifest.id}'（与 ${path.basename(prev.dir)} 重复）`,
      })
      continue
    }
    byId.set(p.manifest.id, p)
    unique.push(p)
  }

  // 先环检测，再排序。顺序不能反：topoSortPlugins 对环只是「不死循环」的降级处理，
  // 它**不是**检测手段。反过来跑，有环时会先排出一份看似正常的部分顺序。
  const cycles = findPluginCycles(unique.map((p) => p.manifest))
  const cyclic = new Set(cycles.flat())

  // 安装顺序**只含能排出来的**：环内成员给不出真顺序，宁可少列，
  // 也不列一个假的让 S7-2b 照着启（那会让它们互相等待直到一起超时）。
  const installOrder = topoSortPlugins(unique.map((p) => p.manifest))
    .map((m) => m.id)
    .filter((id) => !cyclic.has(id))

  // 展示排序是**另一件事**：安装顺序在前，环内成员按 id 稳定地排在最后，
  // 这样界面里「起不来的那几个」连成一排，而不是夹在正常插件中间。
  const display = [...installOrder, ...[...cyclic].sort()]
  const rank = new Map(display.map((id, i) => [id, i]))
  unique.sort((a, b) => (rank.get(a.manifest.id) ?? 0) - (rank.get(b.manifest.id) ?? 0))

  return {
    pluginsDir,
    status: unique.length === 0 ? 'empty' : 'ok',
    plugins: unique,
    problems,
    cycles,
    ids: unique.map((p) => p.manifest.id),
    installOrder,
  }
}

/**
 * 把扫盘结果 + 真实服务状态聚合成对外快照。
 *
 * 状态判定本身**不在这里** —— 全部委托给 shared 的 `resolvePluginState`，
 * Core 与前端跑同一份逻辑。这里只做两件 Core 特有的事：
 *   ① 把「已安装」算成 `installedPluginIds`（**排除被卸掉的**）
 *   ② 补 `missingOptional`（共享函数只管必需依赖，可选依赖仅作展示）
 */
export function snapshotPlugins(
  scan: PluginScan,
  opts: {
    /** 服务 id → 真实状态。由 `ServiceManager.list()` 提供 */
    serviceStates: ReadonlyMap<string, ServiceStatus>
    /** `preferences.plugins.uninstalled` —— 装了但被卸掉的 id */
    uninstalledIds?: ReadonlySet<string>
  },
): PluginSnapshot[] {
  const present = new Set(scan.ids)

  // `installed` 与「依赖是否满足」是两个不同的集合，别混：
  //
  // · installed = 目录在 且 没被卸掉。这只回答「用户装了吗」。
  // · installedPluginIds（喂给 resolvePluginState）= **能在 installOrder 里被启的**。
  //   环内插件虽然装了，但永远起不来 —— 依赖它的插件必须知道这一点，否则会
  //   以为「对方在，只是慢」，而实际上对方根本不会 ready。
  const installedPluginIds = new Set(
    scan.installOrder.filter((id) => !opts.uninstalledIds?.has(id)),
  )
  const isInstalled = (id: string): boolean => present.has(id) && !opts.uninstalledIds?.has(id)

  return scan.plugins.map(({ manifest }) => {
    const missingOptional = manifest.dependencies
      .filter((dep) => dep.optional && !present.has(dep.pluginId))
      .map((dep) => dep.pluginId)

    const serviceStates: Record<string, ServiceStatus | undefined> = {}
    const statesForCall = new Map<string, string>()
    for (const sid of manifest.services) {
      const st = opts.serviceStates.get(sid)
      serviceStates[sid] = st
      if (st !== undefined) statesForCall.set(sid, st)
    }

    const result = resolvePluginState({ manifest, serviceStates: statesForCall, installedPluginIds })

    return {
      manifest,
      installed: isInstalled(manifest.id),
      state: result.state,
      reason: result.reason,
      missingDependencies: result.missingDependencies,
      missingOptional,
      unhealthyServices: result.unhealthyServices,
      readyServiceCount: result.readyServiceCount,
      serviceStates,
    }
  })
}

/**
 * 扫盘期该说的话。**只告警，不改数据** —— 抽出来是为了让「扫一次」与
 * 「聚合一次」能分开调用（PluginRegistry 构造时只扫盘，不聚合）。
 */
export function warnAboutScan(scan: PluginScan): void {
  if (scan.status === 'missing-dir') {
    logger.warn(
      `plugin layer: dir not found (${scan.pluginsDir}) -> 未安装任何插件；已退回全启`,
    )
  } else if (scan.status === 'empty') {
    logger.warn(
      `plugin layer: ${scan.pluginsDir} 里没有任何 plugin.json -> 未安装任何插件；已退回全启。` +
        `如果预期不是这样，是否漏了 S7-5（5 个 plugin.json 尚未落盘）？`,
    )
  }
  for (const p of scan.problems) {
    logger.warn(`plugin layer: ${p.where}: ${p.reason}`)
  }
  for (const cycle of scan.cycles) {
    logger.error(
      `plugin layer: 依赖成环 ${cycle.join(' -> ')} -> 这几个插件不会进入安装顺序，` +
        `状态按「必需依赖缺失」聚合为 degraded`,
    )
  }
}

/**
 * 扫盘 + 告警 + 打快照（一步到位版）。
 *
 * 告警只给 `missing-dir` / `empty` —— 这两种是「大概率手滑」；`disabled` 是有意关掉，
 * 不该 nag（有测试在用）。S7-2a 只**报告**不降级；真要退回全启由
 * `PluginRegistry.allowedServiceIds()` 决定（S7-2b）。
 */
export function loadPluginLayer(options: {
  pluginsDir: string | undefined
  knownServiceIds?: ReadonlySet<string>
  serviceStates: ReadonlyMap<string, ServiceStatus>
  uninstalledIds?: ReadonlySet<string>
}): { scan: PluginScan; snapshots: PluginSnapshot[] } {
  const scan = scanPlugins(options.pluginsDir, options.knownServiceIds)
  warnAboutScan(scan)
  return { scan, snapshots: snapshotPlugins(scan, options) }
}