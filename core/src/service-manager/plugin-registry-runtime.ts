/**
 * 插件层运行时（S7-2a：只读）
 *
 * `scanPlugins` 负责「读盘」，本类负责「持有 + 对外暴露 + 状态变化时发事件」。
 *
 * ## 状态是**派生**的，所以事件只在变化时发
 *
 * 插件状态由「服务真实状态 + 依赖满足情况」算出来（`resolvePluginState`），
 * 它没有自己的存储。因此本类记住上一次的聚合结果，**只在真的变了才 publish**
 * `plugin.state.changed`：
 *
 * · 一直发 → 服务每次心跳抖动都推一遍，前端得自己做去重
 * · 一次都不发 → 前端永远拿不到 `starting → ready` 的跃迁
 *
 * ## 刷新时机
 *
 * 挂 `service.*` 生命周期事件，而不是轮询：状态变化的**唯一**来源就是服务状态变化，
 * 轮询只是把同一个信息换个方式取回来，还多一份定时器要清理。
 */
import type { ServiceStatus } from '@osteosome/shared'
import type { PluginState } from '@osteosome/shared'
import type { Bus } from '../bus/bus'
import { logger } from '../logger'
import {
  loadPluginLayer,
  scanPlugins,
  snapshotPlugins,
  warnAboutScan,
  type PluginLayerStatus,
  type PluginProblem,
  type PluginScan,
  type PluginSnapshot,
} from './plugin-registry'

/** `GET /api/plugins` 的响应体 */
export interface PluginListResponse {
  /** 插件层是否可用 —— 前端据此决定「插件未启用」还是「插件没装好」 */
  layer: PluginLayerStatus
  pluginsDir: string | null
  /** 安装顺序（依赖在前，**不含环内成员**）。前端不需要，但排障有用 */
  installOrder: string[]
  /** 扫描期问题。注意这**不是** per-plugin 状态，别把它混进列表渲染 */
  problems: PluginProblem[]
  /** 依赖环 */
  cycles: string[][]
  plugins: PluginSnapshot[]
}

/** 参与聚合的等价性判断。只看会影响展示的字段 */
function sameSnapshots(a: PluginSnapshot[], b: PluginSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.manifest.id !== y.manifest.id ||
      x.state !== y.state ||
      x.installed !== y.installed ||
      x.reason !== y.reason ||
      x.readyServiceCount !== y.readyServiceCount ||
      x.unhealthyServices.join(',') !== y.unhealthyServices.join(',') ||
      x.missingDependencies.join(',') !== y.missingDependencies.join(',')
    ) {
      return false
    }
  }
  return true
}

export class PluginRegistry {
  private scan: PluginScan
  /**
   * 上一次聚合结果，`null` = **还没算过**。
   *
   * 刻意不在构造函数里算：算聚合需要「服务真实状态」，而那来自 ServiceManager ——
   * 构造函数跑在 ServiceManager 之前（S7-2b 要先算白名单再建它），所以那时拿不到。
   * 于是改成首次使用时才算，而不是加一个「构造后再回填」的引用 hack。
   */
  private lastCache: PluginSnapshot[] | null = null
  /** 连续多次事件撞在一起时只算一次（比如一次启动会连发 starting + ready） */
  private refreshQueued = false

  constructor(
    private readonly bus: Bus,
    private readonly options: {
      pluginsDir: string | undefined
      knownServiceIds?: ReadonlySet<string>
      /** 取当前服务真实状态。由 `ServiceManager.list()` 提供 */
      listServiceStates: () => ReadonlyMap<string, ServiceStatus>
      /** `preferences.plugins.uninstalled` */
      uninstalledIds?: () => ReadonlySet<string>
      /**
       * `preferences.plugins.enabled` 里值为 `false` 的插件 id（S7-4）。
       *
       * 与 `uninstalledIds` 分开而不是合成一个集合：两者语义不同 ——
       * 停用是「我暂时不要」，卸载是「我不要了」，界面要区别对待。
       */
      disabledIds?: () => ReadonlySet<string>
      /** 真实服务启停。由 `ServiceManager` 提供（ServiceManager 不知道插件存在） */
      controlService: (command: 'start' | 'stop', serviceId: string) => Promise<void>
    },
  ) {
    this.scan = scanPlugins(options.pluginsDir, options.knownServiceIds)
    warnAboutScan(this.scan)
  }

  /** 上一次聚合结果；没有就算一次并记下 */
  private last(): PluginSnapshot[] {
    if (this.lastCache === null) this.lastCache = this.snapshots()
    return this.lastCache
  }

  /** 把插件层挂到服务生命周期上。Core 启动完成后调一次即可 */
  attach(): void {
    for (const topic of [
      'service.starting',
      'service.ready',
      'service.restarting',
      'service.failed',
      'service.stopped',
    ] as const) {
      this.bus.subscribe(topic, () => this.scheduleRefresh())
    }
  }

  /** 重新算一遍；变了才发事件 */
  refresh(): void {
    this.refreshQueued = false
    const next = this.snapshots()
    const before = this.lastCache
    this.lastCache = next
    // 首次：lastCache 原来是 null。这一轮算作「初始状态」，全部插件都算变了 ——
    // 这是对的：前端正需要拿到它们的初始状态。
    const prev: Map<string, PluginState> =
      before === null ? new Map() : new Map(before.map((p) => [p.manifest.id, p.state]))
    if (before !== null && sameSnapshots(before, next)) return
    const changed = next.filter((p) => prev.get(p.manifest.id) !== p.state)
    if (changed.length === 0) return
    logger.info(
      `plugin layer: state changed ${changed
        .map((p) => `${p.manifest.id}: ${prev.get(p.manifest.id) ?? '-'} -> ${p.state}`)
        .join(', ')}`,
    )
    // 契约是**一个插件一条**（payload 带 pluginId），不是打包成数组 ——
    // 前端可以直接把 payload 塞进 store 的对应条目，不用先解包。
    for (const p of changed) this.publishOne(p)
  }

  private publishOne(p: PluginSnapshot): void {
    this.bus.publish('plugin.state.changed', {
      // 与 ServiceManager 的 publish 同一套约定：ts/source 由发布方补，bus 不代劳
      ts: Date.now(),
      source: 'core',
      pluginId: p.manifest.id,
      state: p.state,
      reason: p.reason,
      missingDependencies: p.missingDependencies,
      readyServices: p.readyServiceCount,
      totalServices: p.manifest.services.length,
    })
  }

  private scheduleRefresh(): void {
    if (this.refreshQueued) return
    this.refreshQueued = true
    // 微任务里合并：一次启动会连发 starting/ready，不合并就是三次全量聚合
    queueMicrotask(() => this.refresh())
  }

  /**
   * 重新聚合状态。**不重新扫盘** —— 磁盘只在构造时（或显式 `rescan()`）读一次。
   *
   * 盘是慢的、告警是吵的：把 `loadPluginLayer`（含 readdir + logger.warn）放进这条
   * 每次服务心跳都会走的路径上，等于把一次扫盘放大成几十次，还重复刷告警。
   */
  snapshots(): PluginSnapshot[] {
    return snapshotPlugins(this.scan, {
      serviceStates: this.options.listServiceStates(),
      uninstalledIds: this.options.uninstalledIds?.(),
    })
  }

  /**
   * 重新读盘（装了 / 卸了插件之后调）。
   *
   * 与 `refresh()` 分开是刻意的：装插件改的是「清单」，服务状态没变；
   * 两者混在一起就没法判断到底该发什么事件。
   */
  rescan(): void {
    const { scan, snapshots } = loadPluginLayer({
      pluginsDir: this.options.pluginsDir,
      knownServiceIds: this.options.knownServiceIds,
      serviceStates: this.options.listServiceStates(),
      uninstalledIds: this.options.uninstalledIds?.(),
    })
    this.scan = scan
    this.lastCache = snapshots
    for (const p of snapshots) this.publishOne(p)
  }

/**
   * 插件的运行期控制（S7-2b）：把 `plugin.start` / `plugin.stop` 展开成服务启停。
   *
   * ## 为什么放这里而不是 ServiceManager
   *
   * 「一个插件包含哪些服务」是**插件层的数据**。ServiceManager 只知道服务 id，
   * 让它反过来去查插件就破坏了刚定下的依赖方向（S7-2b 设计定案 ①）。
   *
   * ## 停之前先 loop.cancel
   *
   * 若该插件含 `loop` 进程，先发一次 `loop.cancel` 让它正常收尾再停 ——
   * 直接杀会留下半截 assistant 消息（消息已经 append 了内容但没有 finishReason）。
   * 这是**尽力而为**：cancel 是 fire-and-forget，不等它回来。
   */
  async control(
    command: 'start' | 'stop',
    pluginId: string,
  ): Promise<{ serviceIds: string[] } | string> {
    const plugin = this.scan.plugins.find((p) => p.manifest.id === pluginId)
    if (!plugin) return `plugin '${pluginId}' not installed`

    if (command === 'stop' && plugin.manifest.services.includes('loop')) {
      // loop.cancel 是命令载荷（只要 requestId），不是事件 —— 不补 ts/source
      this.bus.publish('loop.cancel', { requestId: `plugin.stop:${pluginId}` })
    }

    for (const sid of plugin.manifest.services) {
      try {
        if (command === 'start') await this.options.controlService('start', sid)
        else await this.options.controlService('stop', sid)
      } catch (err) {
        // 一个服务停不下来不该让整条命令失败 —— 其余服务继续处理，
        // 否则「停 reliability」会因为 llm-retry 卡住而连 credentials 也不停。
        logger.warn(`plugin.${command} ${pluginId}: service '${sid}' failed: ${String(err)}`)
      }
    }

    // 启停改变了服务真实状态 -> 重算并广播
    this.refresh()
    return { serviceIds: [...plugin.manifest.services] }
  }

  /** `GET /api/plugins` 的响应体 */
  list(): PluginListResponse {
    return {
      layer: this.scan.status,
      pluginsDir: this.scan.pluginsDir,
      installOrder: this.scan.installOrder,
      problems: this.scan.problems,
      cycles: this.scan.cycles,
      plugins: this.snapshots(),
    }
  }

  /**
   * 允许启动的服务 id 集合 —— **B 语义的唯一决策点**（S7-2b）。
   *
   * 返回 `undefined` = **不限制**（照旧全启）。这与返回空集合是两种不同的意思。
   *
   * ## 为什么要「唯一决策点」
   *
   * 三态降级的判断必须只有一处知道。若把它散进 ServiceManager 或各个命令处理器，
   * 就会出现「有的路径全启、有的路径过滤」的不一致 —— 而这种不一致只在特定
   * 组合下才暴露，排查成本极高。所以 ServiceManager 只看到「一个集合或没有」。
   *
   * ## 三态
   * · `disabled`    -> 不限制。有意关掉（逃生门 / 测试），不告警
   * · `missing-dir` -> 不限制 + 告警。路径写错，此时若照 B 语义就是零服务 = 应用不可用
   * · `empty`       -> 不限制 + 告警。目录在但没清单，同上
   * · `ok`          -> 按下面四条规则过滤
   *
   * ## 四条不 spawn 规则（或关系）
   * ① 属于 `uninstalled` 的插件
   * ② 属于 `autoStart:false` 的插件（装了但声明不自动起）
   * ③ 属于环内插件 —— 不在 `installOrder` 里，它的依赖无解
   * ④ **用户显式停用的插件**（`preferences.plugins.enabled[id] === false`）
   *
   * ④ 是 S7-4 补上的，漏掉它会有一个很典型的症状：
   * 用户禁用某插件 -> 当天一切正常 -> **重启 Core 后它自己回来了**。
   * 因为运行期的停用是靠 `plugin.stop` 命令完成的，而启动路径只看 `uninstalled`。
   * 两处不共享同一份判定，就会出现「运行期生效、重启失效」。
   *
   * ## 刻意**不**包含的一条
   *
   * 「依赖未满足」**不**阻止 spawn。`session` 独立可用：不装 models 时用户仍要能看
   * 会话列表和历史，仅因缺 provider 就杀掉 session 是真实的功能回退。
   * 依赖不满足只让状态变 `degraded` —— 这正是 S7-1 把它判成 degraded 而非 failed
   * 的意义（「仍该显示、仍该让用户看见缺什么，只是发不出请求」）。
   */
  allowedServiceIds(): ReadonlySet<string> | undefined {
    if (this.scan.status !== 'ok') {
      logger.warn(
        `plugin layer: '${this.scan.status}' -> 不按插件过滤，全部服务照旧启动`,
      )
      return undefined
    }

    const uninstalled = this.options.uninstalledIds?.() ?? new Set<string>()
    const disabled = this.options.disabledIds?.() ?? new Set<string>()
    const cyclic = new Set(this.scan.cycles.flat())
    const allowed = new Set<string>()

    for (const { manifest } of this.scan.plugins) {
      if (uninstalled.has(manifest.id)) continue
      if (disabled.has(manifest.id)) continue
      if (manifest.autoStart === false) continue
      if (cyclic.has(manifest.id)) continue
      for (const sid of manifest.services) allowed.add(sid)
    }

    logger.info(
      `plugin layer: 允许启动 ${allowed.size} 个服务（按 ${this.scan.plugins.length} 个已安装插件计算）`,
    )
    return allowed
  }
}