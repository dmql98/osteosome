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
import type { Bus } from '../bus/bus'
import { logger } from '../logger'
import {
  loadPluginLayer,
  snapshotPlugins,
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
  private last: PluginSnapshot[]
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
    },
  ) {
    const { scan, snapshots } = loadPluginLayer({
      pluginsDir: options.pluginsDir,
      knownServiceIds: options.knownServiceIds,
      serviceStates: options.listServiceStates(),
      uninstalledIds: options.uninstalledIds?.(),
    })
    this.scan = scan
    this.last = snapshots
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
    if (sameSnapshots(this.last, next)) return
    const before = new Map(this.last.map((p) => [p.manifest.id, p.state]))
    this.last = next
    const changed = next.filter((p) => before.get(p.manifest.id) !== p.state)
    logger.info(
      `plugin layer: state changed ${changed
        .map((p) => `${p.manifest.id}: ${before.get(p.manifest.id)} -> ${p.state}`)
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
    this.last = snapshots
    for (const p of snapshots) this.publishOne(p)
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
}