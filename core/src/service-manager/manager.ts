/**
 * ServiceManager（RFC §3 / WS-3）—— 进程生命周期编排。
 *
 * - 启动：扫 manifest → 拓扑排序 → 逐个 spawn + initialize 握手 + 注册 + 心跳
 * - 生命周期事件：service.starting / ready / restarting / failed / stopped（带 ts/source）
 * - stdio JSON-RPC：Core 应答 initialize，受理 bus.publish / bus.subscribe / bus.unsubscribe /
 *   shutdown，按 topic 把事件推给对应服务（bus.event）
 * - 崩溃 / 协议错误 / 心跳超时 → 重启（backoff，超 maxRestarts → failed）
 * - 特权只读方法：preferences.get / plugins.readFile（后者 P3）
 */
import { readFileSync, statSync, type Stats as FsStats } from 'node:fs'
import { resolve as pathResolve, sep } from 'node:path'
import type { Bus } from '../bus/bus'
import { readPreferences } from '../preferences'
import {
  DEFAULT_HEALTH_CHECK,
  DEFAULT_RESTART_POLICY,
  HANDSHAKE_TIMEOUT_MS,
  type EventKey,
  type EventPayload,
  type HealthCheck,
  type InitializeParams,
  type InitializeResult,
  type Manifest,
  type PaneDescriptor,
  type RestartPolicy,
  type ServiceInfo,
  type ServiceId,
  type ServiceStatus,
} from '@osteosome/shared'
import { logger } from '../logger'
import {
  FramingError,
  JsonRpcClient,
  createInitializeResult,
  jsonRpcError,
} from './jsonrpc'
import { HealthMonitor } from './health'
import { loadServicesFrom } from './manifest'
import { forceKill, sendSigterm, spawnServiceProcess, waitExit, type ManagedProcess } from './process'
import { topologicalOrder } from './topology'

const DEFAULT_STOP_GRACE_MS = 5000
const DEFAULT_BACKOFF_BASE_MS = 1000
const DEFAULT_CONSECUTIVE_HEALTH_FAILURES = 3

/**
 * `plugins.readFile` 的单文件上限（P3）—— 2 MiB。
 *
 * 这个 RPC 的用途是读「插件自带的静态数据」（catalog.json 这类），那种文件是 KB 级。
 * 2 MiB 已经大到能塞下一份压缩过的模型清单，再大就说明有人拿它当通用文件通道用了。
 */
const PLUGIN_READFILE_MAX_BYTES = 2 * 1024 * 1024

interface HandshakeWaiter {
  resolve: (params: InitializeParams) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface ReadyWaiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface ManagedService {
  manifest: Manifest
  dir: string
  status: ServiceStatus
  pid?: number
  startedAt?: number
  restartCount: number
  proc?: ManagedProcess
  client?: JsonRpcClient
  health?: HealthMonitor
  healthFailures: number
  stoppedByUs: boolean
  protocolFailedReason?: string
  restartReasonOverride?: string
  /**
   * 最近一次失败的原因，`/health` 的 `ServiceInfo.reason` 就是它。
   *
   * 与 `protocolFailedReason` 的分工：那个是**瞬时**的，`handleExit` 读完即清、
   * 只活在 `service.failed` 事件里；这个跨过事件仍留在快照上。每个新 spawn 重置，
   * 转到 `ready` 时也重置。
   */
  failReason?: string
  handshakeWaiter?: HandshakeWaiter
  readyWaiter?: ReadyWaiter
  /** initialize 响应已验证；真正的 ready 仍等待 initialized 通知。 */
  initializeParams?: InitializeParams
  initializedReceived?: boolean
}

export interface ServiceManagerOptions {
  /**
   * 服务目录清单（每个里面直接放 `<id>/service.json`）。
   *
   * P1 之后服务住在插件里（`plugins/<id>/services/<sid>/`），所以是**多个根**。
   * 由 `main.ts` 从插件清单算出 —— **ServiceManager 仍然不知道插件存在**，
   * 它只收一张字符串表（与 `allowedServiceIds` 同一性质：别人算好的值）。
   */
  serviceDirs: readonly string[]
  dataDir: string
  /**
   * 服务 id → 它自己的数据根（`userData/plugin/<pluginId>/`）。
   *
   * 缺省 = 退回 `dataDir`（**旧行为**，只有测试与逃生门会走到）。
   * 生产路径必须有这张表：否则服务会把数据写到用户数据根里，多个插件共用一个目录。
   */
  serviceDataDirs?: ReadonlyMap<ServiceId, string>
  /**
   * 服务 id → **它所属插件的目录**（`plugins/<id>/`）（P3）。
   *
   * 存在的唯一理由是 `plugins.readFile`：服务要读自己插件目录下的文件
   * （`catalog.json` 这类插件自带数据），而读文件必须有边界。边界就是「自己插件的目录」。
   *
   * 为什么给的是**目录**而不是别的：ServiceManager 不该知道插件 id 或 `plugins/<id>/`
   * 这个布局（那是插件层的知识），它只把 Core 算好的一个根交给文件读取去卡前缀。
   * 表里没有的服务调用 `plugins.readFile` 会拿到 `no plugin directory` 而不是文件内容 ——
   * **fail closed**，绝不因为「没配表」就退化成读任意路径。
   */
  servicePluginDirs?: ReadonlyMap<ServiceId, string>
  /**
   * Core 自己的版本（P2）—— 随握手回给服务（`InitializeResult.coreVersion`）。
   *
   * 服务据此能自己判断「我这个插件声明的 coreCompatibility 在这台 Core 上成立吗」，
   * 缺省时**不判断**（服务可以只信任 Core 侧那道闸）。
   */
  coreVersion?: string
  sessionId: string
  bus: Bus
  handshakeTimeoutMs?: number
  stopGraceMs?: number
  maxRestarts?: number
  backoffBaseMs?: number
  consecutiveHealthFailures?: number
  /** 可注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>
  /**
   * 允许启动的服务 id 集合（S7-2b B 语义）。
   *
   * **不传 = 全启**，这是默认且必须保持的默认：它让 ServiceManager 彻底不知道
   * 插件的存在，也让所有直接构造它的测试（临时 services 目录 + 假服务）零改动。
   *
   * 「不传」与「传空集合」是**两种不同的意思**，别混：
   * · 不传    -> 不限制，照旧全启（逃生门 `none`，以及所有既有测试）
   * · 传空集合 -> 一个都不启（没有任何插件认领服务）
   *
   * 被过滤掉的服务**仍然会被登记**（出现在 `/health` 与 `list()` 里，状态 `stopped`），
   * 只是不 spawn。这样界面能看出「这个服务存在、但所属插件没装」，
   * 而不是「这个服务不存在」。心跳与僵尸检测只在 spawn 时挂载，
   * 所以未 spawn 的服务不会被误判成 failed。
   */
  allowedServiceIds?: ReadonlySet<string>
}

/** 带 ts/source 的生命周期事件发布（source 永远 core） */
type LifecyclePayload<E extends EventKey> = Omit<EventPayload<E>, 'ts' | 'source'>

export class ServiceManager {
  private readonly services = new Map<ServiceId, ManagedService>()
  private readonly startOrder: Manifest[] = []
  private readonly handshakeTimeoutMs: number
  private readonly stopGraceMs: number
  private readonly maxRestarts: number
  private readonly backoffBaseMs: number
  private readonly consecutiveHealthFailures: number
  private readonly sleepImpl: (ms: number) => Promise<void>

  constructor(private readonly options: ServiceManagerOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
    this.maxRestarts = options.maxRestarts ?? DEFAULT_RESTART_POLICY.maxRestarts
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    this.consecutiveHealthFailures =
      options.consecutiveHealthFailures ?? DEFAULT_CONSECUTIVE_HEALTH_FAILURES
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * 握手时交给服务的 `dataDir` —— 它**自己插件**的数据根。
   *
   * 缺表项就退回 `dataDir`（旧行为）。生产路径一定有表：`main.ts` 用插件清单算出，
   * 所以「服务属于哪个插件」这件事在本类里根本不存在 —— 这里只是查一张外部算好的表。
   */
  private dataDirOf(serviceId: ServiceId): string {
    return this.options.serviceDataDirs?.get(serviceId) ?? this.options.dataDir
  }

  async start(): Promise<void> {
    await this.options.bus.ready()
    const loaded = loadServicesFrom(this.options.serviceDirs)
    this.startOrder.length = 0
    const sequence = topologicalOrder(loaded.map((s) => s.manifest))
    for (const manifest of sequence) {
      const dir = loaded.find((s) => s.manifest.id === manifest.id)!.dir
      this.services.set(manifest.id, {
        manifest,
        dir,
        status: 'starting',
        restartCount: 0,
        healthFailures: 0,
        stoppedByUs: false,
      })
      this.startOrder.push(manifest)
    }
    for (const manifest of sequence) {
      const svc = this.services.get(manifest.id)!
      if (!this.mayStart(manifest.id)) {
        // 登记但不 spawn（见 options.allowedServiceIds 的说明）
        svc.status = 'stopped'
        logger.info(
          `[svc] '${manifest.id}' registered but not started（所属插件未安装/未自动启动/依赖成环）`,
        )
        continue
      }
      await this.spawnAndHandshake(svc)
    }
  }

  /**
   * 该服务此刻是否允许启动。
   *
   * **每次都重新判断**而不是在 start() 里算一次存起来：运行期插件可以被
   * `plugin.start` 启、被 `preferences` 卸掉，判定必须跟着变。
   */
  private mayStart(serviceId: ServiceId): boolean {
    const allowed = this.options.allowedServiceIds
    return allowed === undefined || allowed.has(serviceId)
  }

  /**
   * 供 `plugin.start` 用：启动一个已登记但尚未 spawn 的服务。
   *
   * 与 `startServicePublic` 分开是因为语义不同 —— 后者是「重启一个已在跑的服务」，
   * 不知道该怎么处理一个 `stopped` 的、可能从没握过手的条目。
   */
  async startRegistered(serviceId: ServiceId): Promise<void> {
    const svc = this.services.get(serviceId)
    if (!svc) throw new Error(`start: unknown service '${serviceId}'`)
    if (!this.mayStart(serviceId)) {
      throw new Error(`start: '${serviceId}' 不允许启动（所属插件未安装）`)
    }
    if (svc.status === 'ready' || svc.status === 'starting') return
    await this.spawnAndHandshake(svc)
  }

  async stop(timeoutMs?: number): Promise<void> {
    const grace = timeoutMs ?? this.stopGraceMs
    const reversed = [...this.startOrder].reverse()
    for (const manifest of reversed) {
      const svc = this.services.get(manifest.id)
      if (!svc) continue
      await this.stopService(svc, grace)
    }
  }

  async restart(serviceId: ServiceId): Promise<void> {
    const svc = this.services.get(serviceId)
    if (!svc) throw new Error(`restart: unknown service '${serviceId}'`)
    await this.stopService(svc, this.stopGraceMs)
    await this.spawnAndHandshake(svc)
  }

  /** 停用单个服务（系统级服务控制命令用）；未知服务抛错 */
  async stopServicePublic(serviceId: ServiceId): Promise<void> {
    const svc = this.services.get(serviceId)
    if (!svc) throw new Error(`stop: unknown service '${serviceId}'`)
    await this.stopService(svc, this.stopGraceMs)
  }

  /** 启动单个服务（系统级服务控制命令用）；未知服务抛错，已启动则幂等 */
  async startServicePublic(serviceId: ServiceId): Promise<void> {
    const svc = this.services.get(serviceId)
    if (!svc) throw new Error(`start: unknown service '${serviceId}'`)
    if (svc.status === 'starting' || svc.status === 'ready') return
    await this.spawnAndHandshake(svc)
  }

  status(serviceId: ServiceId): ServiceStatus {
    return this.services.get(serviceId)?.status ?? 'stopped'
  }

  list(): ServiceInfo[] {
    const out: ServiceInfo[] = []
    for (const manifest of this.startOrder) {
      const svc = this.services.get(manifest.id)
      if (!svc) continue
      out.push({
        id: svc.manifest.id,
        version: svc.manifest.version,
        status: svc.status,
        ...(svc.pid != null ? { pid: svc.pid } : {}),
        ...(svc.startedAt != null ? { startedAt: svc.startedAt } : {}),
        restartCount: svc.restartCount,
        ...(svc.failReason != null ? { reason: svc.failReason } : {}),
      })
    }
    return out
  }

  // ── 启动/握手 ─────────────────────────────────────
  private async spawnAndHandshake(svc: ManagedService): Promise<void> {
    const spawned = this.spawnService(svc)
    try {
      // 必须在等待 initialize 之前建立 ready waiter：Core 可能在同一 stdout
      // chunk 中连续收到 initialize 响应与 initialized 通知。
      const ready = this.armReady(svc)
      // 若 initialize 先失败，spawnAndHandshake 会走 catch；提前挂 rejection handler
      // 避免 ready waiter 的超时/失败变成未处理 Promise rejection。
      ready.catch(() => undefined)
      const params = await this.armHandshake(svc)
      // initialize 响应只代表协议参数已验证；SDK 会在补发本地订阅后发送
      // initialized，Core 收到该通知才允许发布 service.ready。
      svc.initializeParams = params
      if (svc.initializedReceived) {
        svc.initializedReceived = false
        const waiter = svc.readyWaiter
        if (waiter) {
          clearTimeout(waiter.timer)
          svc.readyWaiter = undefined
          this.readyService(svc, params)
          waiter.resolve()
        }
      } else {
        await ready
      }
    } catch (err) {
      if (svc.readyWaiter) {
        clearTimeout(svc.readyWaiter.timer)
        svc.readyWaiter = undefined
      }
      logger.error(`[${svc.manifest.id}] handshake failed: ${String(err)}`)
      // 握手超时/初始化被拒这类失败不一定走 protocolFailedReason，
      // 先把原因留在快照上，handleExit 若有更具体的 protocolFailedReason 再覆盖。
      if (svc.failReason === undefined) svc.failReason = String(err)
      // 只杀本次 spawn 的进程（期间可能已被重启链替换为新进程，勿误杀）
      if (svc.proc === spawned && spawned.child.exitCode === null) {
        forceKill(spawned.child)
      }
    }
  }

  private spawnService(svc: ManagedService): ManagedProcess {
    const manifest = svc.manifest
    const proc = spawnServiceProcess(manifest.entry, { cwd: svc.dir })
    svc.proc = proc
    svc.pid = proc.child.pid
    svc.startedAt = Date.now()
    svc.stoppedByUs = false
    svc.status = 'starting'
    svc.failReason = undefined

    const client = new JsonRpcClient({
      conn: { write: (c) => proc.child.stdin?.write(c) },
    })
    svc.client = client
    this.hookClient(svc, client)
    // 进程被杀/自退后向 stdin 写会抛 EPIPE：吞掉即可（正常信号）
    proc.child.stdin?.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
      logger.debug(`[${manifest.id}] stdin error: ${String(err)}`)
    })
    proc.child.stdout?.on('data', (c: Buffer) => client.handleChunk(c))
    proc.child.stderr?.on('data', (c: Buffer) => this.logServiceStderr(svc, c))

    this.publish('service.starting', { serviceId: manifest.id, version: manifest.version })

    proc.exited.then(({ code, signal }) => {
      if (svc.proc !== proc) return // 已被新进程取代
      void this.handleExit(svc, code, signal)
    })
    return proc
  }

  private armHandshake(svc: ManagedService): Promise<InitializeParams> {
    return new Promise<InitializeParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`handshake timeout after ${this.handshakeTimeoutMs}ms`))
      }, this.handshakeTimeoutMs)
      svc.handshakeWaiter = { resolve, reject, timer }
    })
  }

  private armReady(svc: ManagedService): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`initialized timeout after ${this.handshakeTimeoutMs}ms`))
      }, this.handshakeTimeoutMs)
      svc.readyWaiter = { resolve, reject, timer }
    })
  }

  private readyService(svc: ManagedService, params: InitializeParams): void {
    const manifest = svc.manifest
    this.verifyInitialize(svc, params)
    svc.status = 'ready'
    svc.protocolFailedReason = undefined
    svc.failReason = undefined
    svc.initializeParams = undefined
    const hc: HealthCheck = manifest.healthCheck ?? DEFAULT_HEALTH_CHECK
    this.startHealth(svc, hc)
    const panes: PaneDescriptor[] | undefined = manifest.panes
    this.publish('service.ready', {
      serviceId: manifest.id,
      version: manifest.version,
      ...(panes && panes.length > 0 ? { panes } : {}),
    })
  }

  /** initialize 请求交叉校验（服务端 manifest 快照 vs 磁盘 manifest） */
  private verifyInitialize(svc: ManagedService, params: InitializeParams): void {
    const disk = svc.manifest
    if (params.serviceId !== disk.id) {
      throw new Error(`initialize serviceId '${params.serviceId}' != manifest '${disk.id}'`)
    }
    if (params.protocolVersion !== disk.protocolVersion) {
      throw new Error(
        `initialize protocolVersion '${params.protocolVersion}' != manifest '${disk.protocolVersion}'`,
      )
    }
    const snap = params.manifest as {
      publishes?: unknown
      subscribes?: unknown
      version?: unknown
    }
    const sameList = (a: unknown, b: unknown): boolean =>
      JSON.stringify(a) === JSON.stringify(b)
    if (sameList(snap?.publishes, disk.publishes) === false) {
      throw new Error('initialize manifest publishes mismatch with on-disk manifest')
    }
    if (sameList(snap?.subscribes, disk.subscribes) === false) {
      throw new Error('initialize manifest subscribes mismatch with on-disk manifest')
    }
  }

  // ── stdio 路由 ────────────────────────────────────
  private hookClient(svc: ManagedService, client: JsonRpcClient): void {
    client.onRequest = async (method, params) => {
      switch (method) {
        case 'initialize':
          return this.handleInitialize(svc, params as InitializeParams)
        case 'bus.publish': {
          const { topic, payload } = (params ?? {}) as { topic?: string; payload?: Record<string, unknown> }
          if (typeof topic !== 'string') throw jsonRpcError(-32602, 'bus.publish: topic required')
          if (!svc.manifest.publishes.includes(topic)) {
            throw jsonRpcError(-32001, `bus.publish: topic '${topic}' is not declared by service`)
          }
          this.options.bus.publish(topic, { ...(payload ?? {}), source: svc.manifest.id })
          return { ok: true }
        }
        case 'bus.subscribe': {
          const { topic } = (params ?? {}) as { topic?: string }
          if (typeof topic !== 'string') throw jsonRpcError(-32602, 'bus.subscribe: topic required')
          if (!svc.manifest.subscribes.includes(topic)) {
            throw jsonRpcError(-32001, `bus.subscribe: topic '${topic}' is not declared by service`)
          }
          this.subscribeServiceTopic(svc, topic)
          return { ok: true }
        }
        case 'bus.unsubscribe': {
          const { topic } = (params ?? {}) as { topic?: string }
          if (typeof topic !== 'string') throw jsonRpcError(-32602, 'bus.unsubscribe: topic required')
          const disposer = this.serviceSubscriptions.get(`${svc.manifest.id}\u0000${topic}`)
          disposer?.()
          this.serviceSubscriptions.delete(`${svc.manifest.id}\u0000${topic}`)
          return { ok: true }
        }
        case 'shutdown':
          void this.stopService(svc, this.stopGraceMs)
          return { ok: true }
        // ── preferences.get（S3）：只给服务进程；读回**Core 自己**那份配置 ──
        // 点对点特权读，不经总线、不落事件。密钥与接入清单**不在这里**：
        // 它们归使用方插件（`userData/plugin/models/`），由那个插件的服务自己读。
        case 'preferences.get':
          return this.handlePreferencesGet()
        // ── plugins.readFile（P3）：只读、只限**自己插件目录** ──
        case 'plugins.readFile':
          return this.handlePluginReadFile(svc, params)
        default:
          throw jsonRpcError(-32601, `method not found: ${method}`)
      }
    }
    client.onNotification = (method) => {
      switch (method) {
        case 'health.pong':
          svc.health?.confirm()
          break
        case 'initialized': {
          const params = svc.initializeParams
          const waiter = svc.readyWaiter
          if (params) {
            if (waiter) {
              clearTimeout(waiter.timer)
              svc.readyWaiter = undefined
              this.readyService(svc, params)
              waiter.resolve()
            }
          } else {
            svc.initializedReceived = true
          }
          break
        }
        case 'shutdown':
          void this.stopService(svc, this.stopGraceMs)
          break
        default:
          logger.debug(`[${svc.manifest.id}] unhandled notification: ${method}`)
      }
    }
    client.onError = (err) => this.onProtocolError(svc, err)
  }

  /**
   * `preferences.get` —— 服务读回 Core 自己那份配置（布局 / 主题 / 插件启停）。
   *
   * 为什么容错而不报错：偏好文件坏了不该让服务起不来。
   * 但**不能静默** —— 记一条 warn，否则「我的配置没生效」会变成一件查不出原因的事。
   *
   * ⚠️ 这里返回的**只有 Core 自己的键**。密钥与模型接入清单归 models 插件
   * （`userData/plugin/models/`），它们不再经过 Core ——「Core 保管所有插件的数据」
   * 正是这一版要拆掉的东西。
   */
  private handlePreferencesGet(): { preferences: Record<string, unknown>; corrupted: boolean } {
    const { value, corrupted } = readPreferences(this.options.dataDir)
    if (corrupted) {
      logger.warn('service-manager: preferences.json corrupted — services read it as {}')
    }
    return { preferences: value, corrupted }
  }

  /**
   * `plugins.readFile { path }` → `{ content }`（P3）
   *
   * ## 为什么需要它
   *
   * 服务打成了**单文件**，所以它读不到自己插件目录里的任何东西（没有 `require` 能解析到
   * `../../catalog.json`）。但插件确实要带自己的静态数据（models 的 12 家预设就是
   * `catalog.json`）。于是有两条路：把数据编进产物（改一个字都要重新构建），
   * 或者让服务能读自己的目录。选后者 —— **插件自带数据应该是可以不改代码就改的文件**。
   *
   * ## 边界（这是本方法唯一重要的部分）
   *
   * - **只读**：没有 write/delete。插件要持久化就用它自己的 `dataDir`（那里可写）。
   * - **只限自己插件的目录**：`servicePluginDirs` 给的根之外一律 403。
   *   于是**跨插件读文件在结构上不可能**，不需要额外的检查逻辑。
   * - **没有根就是拒绝**（fail closed）：不在 `servicePluginDirs` 表里的服务
   *   （手写 service.json 的旧式服务）拿到的是 `no plugin directory`。
   *   绝不能退化成「没配表就随便读」—— 那等于给任意服务发了文件系统读权限。
   * - **不读 `node_modules`**：那是仓库布局不是插件内容，而且能撑爆响应。
   * - **有大小上限**：读文件走 JSON-RPC，一次几百 KB 就够了；目录、符号链接
   *   逃逸、绝对路径都由前缀检查 + `isFile()` 挡住。
   *
   * 为什么走 **stdio JSON-RPC 而不是 HTTP 路由**：服务本来就有这条私有管道，
   * 再开一个 HTTP 端点就等于给每个服务进程开了一个能读文件的公网入口。
   */
  private handlePluginReadFile(
    svc: ManagedService,
    params: unknown,
  ): { content: string } {
    const { path } = (params ?? {}) as { path?: string }
    if (typeof path !== 'string' || path.length === 0) {
      throw jsonRpcError(-32602, 'plugins.readFile: path required')
    }
    const pluginDir = this.options.servicePluginDirs?.get(svc.manifest.id)
    if (!pluginDir) {
      throw jsonRpcError(
        -32004,
        `plugins.readFile: no plugin directory for service '${svc.manifest.id}'`,
      )
    }

    const root = pathResolve(pluginDir)
    const target = pathResolve(root, path.replace(/^[/\\]+/, ''))
    if (target !== root && !target.startsWith(root + sep)) {
      throw jsonRpcError(-32004, 'plugins.readFile: path outside plugin directory')
    }
    if (target.split(sep).includes('node_modules')) {
      throw jsonRpcError(-32004, 'plugins.readFile: node_modules is not readable')
    }

    let stat: FsStats
    try {
      stat = statSync(target)
    } catch {
      throw jsonRpcError(-32004, `plugins.readFile: not found: ${path}`)
    }
    if (!stat.isFile()) {
      throw jsonRpcError(-32004, `plugins.readFile: not a file: ${path}`)
    }
    if (stat.size > PLUGIN_READFILE_MAX_BYTES) {
      throw jsonRpcError(
        -32004,
        `plugins.readFile: file too large (${stat.size} > ${PLUGIN_READFILE_MAX_BYTES} bytes): ${path}`,
      )
    }
    return { content: readFileSync(target, 'utf8') }
  }

  private async handleInitialize(
    svc: ManagedService,
    params: InitializeParams,
  ): Promise<InitializeResult> {
    try {
      const manifest = svc.manifest
      const hc: HealthCheck = manifest.healthCheck ?? DEFAULT_HEALTH_CHECK
      let result: InitializeResult
      try {
        this.verifyInitialize(svc, params)
        result = createInitializeResult({
          sessionId: this.options.sessionId,
          heartbeatInterval: hc.interval,
          dataDir: this.dataDirOf(svc.manifest.id),
          coreVersion: this.options.coreVersion ?? '0.0.0',
        })
      } catch (err) {
        // 校验失败 → 错误响应 + 标记 failed 触发重启（协议错误路径）
        svc.protocolFailedReason = String(err)
        if (svc.proc?.child.exitCode === null) forceKill(svc.proc.child)
        throw err
      }
      const waiter = svc.handshakeWaiter
      if (waiter) {
        clearTimeout(waiter.timer)
        svc.handshakeWaiter = undefined
        svc.initializeParams = params
        waiter.resolve(params)
      }
      return result
    } catch (err) {
      const waiter = svc.handshakeWaiter
      if (waiter) {
        clearTimeout(waiter.timer)
        svc.handshakeWaiter = undefined
        waiter.reject(err as Error)
      }
      throw err
    }
  }

  // ── 事件路由：Core → 服务 ─────────────────────────
  private readonly serviceSubscriptions = new Map<string, () => void>()

  private subscribeServiceTopic(svc: ManagedService, topic: string): void {
    const key = `${svc.manifest.id}\u0000${topic}`
    if (this.serviceSubscriptions.has(key)) return
    const disposer = this.options.bus.subscribe(topic, (payload, t) => {
      svc.client?.notify('bus.event', { topic: t, payload })
    })
    this.serviceSubscriptions.set(key, disposer)
  }

  // ── 健康检查 ──────────────────────────────────────
  private startHealth(svc: ManagedService, hc: HealthCheck): void {
    svc.health?.stop()
    const health = new HealthMonitor(
      {
        ping: () => svc.client?.notify('health.ping'),
        onDown: (reason) => this.onHealthDown(svc, reason),
        onUp: () => {
          svc.healthFailures = 0
        },
      },
      { interval: hc.interval, timeout: hc.timeout },
    )
    svc.health = health
    health.start()
  }

  private onHealthDown(svc: ManagedService, reason: string): void {
    svc.healthFailures++
    logger.warn(`[${svc.manifest.id}] health down (${svc.healthFailures}/${this.consecutiveHealthFailures}): ${reason}`)
    if (svc.healthFailures >= this.consecutiveHealthFailures && !svc.stoppedByUs) {
      svc.healthFailures = 0
      svc.restartReasonOverride = `health: ${reason}`
      this.closeConnection(svc)
      if (svc.proc?.child.exitCode === null) forceKill(svc.proc.child)
    }
  }

  // ── 退出 / 重启 ───────────────────────────────────
  private async handleExit(svc: ManagedService, code: number | null, signal: string | null): Promise<void> {
    if (svc.stoppedByUs) {
      svc.status = 'stopped'
      this.publish('service.stopped', { serviceId: svc.manifest.id })
      return
    }
    svc.health?.stop()
    this.closeConnection(svc)

    const reason = svc.protocolFailedReason
    svc.protocolFailedReason = undefined
    const override = svc.restartReasonOverride
    svc.restartReasonOverride = undefined
    const exitInfo = code != null ? `exit=${code}` : `signal=${signal ?? 'unknown'}`
    if (reason !== undefined) {
      this.publish('service.failed', {
        serviceId: svc.manifest.id,
        ...(code != null ? { exitCode: code } : {}),
        reason,
      })
      // protocolFailedReason 到这就被清了，留一份到快照上供 /health 查看
      svc.failReason = reason
    }

    const budget = svc.manifest.restartPolicy?.maxRestarts ?? this.maxRestarts
    if (svc.restartCount >= budget) {
      if (reason === undefined) {
        const finalReason = `max restarts (${budget}) exceeded; ${exitInfo}${override !== undefined ? `; ${override}` : ''}`
        this.publish('service.failed', {
          serviceId: svc.manifest.id,
          ...(code != null ? { exitCode: code } : {}),
          reason: finalReason,
        })
        // 握手阶段可能已留下更具体的原因（如 handshake timeout），别被泛化文案盖掉
        if (svc.failReason === undefined) svc.failReason = finalReason
      }
      svc.status = 'failed'
      logger.error(`[${svc.manifest.id}] ${svc.status}: ${exitInfo}`)
      return
    }

    svc.restartCount++
    svc.status = 'restarting'
    this.publish('service.restarting', {
      serviceId: svc.manifest.id,
      reason: `${exitInfo}${reason !== undefined ? `; ${reason}` : override !== undefined ? `; ${override}` : ''}`,
    })
    const delay = this.backoffDelay(svc.manifest.restartPolicy?.backoff, svc.restartCount)
    logger.warn(`[${svc.manifest.id}] restarting in ${delay}ms (attempt ${svc.restartCount})`)
    await this.sleepImpl(delay)
    if (svc.stoppedByUs) return
    await this.spawnAndHandshake(svc)
  }

  private backoffDelay(backoffKind: RestartPolicy['backoff'] | undefined, count: number): number {
    if (backoffKind === 'fixed') return this.backoffBaseMs
    return this.backoffBaseMs * 2 ** Math.max(0, count - 1)
  }

  // ── 优雅停止 ──────────────────────────────────────
  private async stopService(svc: ManagedService, graceMs: number): Promise<void> {
    if (svc.status === 'stopped') return
    svc.stoppedByUs = true
    svc.failReason = undefined
    svc.health?.stop()

    if (svc.proc && svc.proc.child.exitCode === null) {
      svc.client?.notify('shutdown')
      if (!(await waitExit(svc.proc.child, graceMs))) {
        sendSigterm(svc.proc.child)
        if (!(await waitExit(svc.proc.child, graceMs))) {
          forceKill(svc.proc.child)
          await waitExit(svc.proc.child, graceMs)
        }
      }
    } else {
      // 无存活子进程（backoff 等待期 / 已退出）：
      // handleExit 不会再来，直接归档 stopped
      svc.status = 'stopped'
      this.publish('service.stopped', { serviceId: svc.manifest.id })
    }
    // 有存活子进程的情况由 handleExit（stoppedByUs=true）兜底发布 service.stopped
  }

  // ── 协议错误 ──────────────────────────────────────
  private onProtocolError(svc: ManagedService, err: unknown): void {
    const label = err instanceof FramingError ? err.code : 'invalid-json'
    logger.error(`[${svc.manifest.id}] stdio protocol error (${label}): ${String(err)}`)
    if (svc.stoppedByUs) return
    svc.protocolFailedReason = `protocol error (${label}): ${String(err)}`
    this.closeConnection(svc)
    if (svc.proc?.child.exitCode === null) forceKill(svc.proc.child)
  }

  private closeConnection(svc: ManagedService): void {
    svc.client?.close()
    svc.client = undefined
  }

  private logServiceStderr(svc: ManagedService, chunk: Buffer): void {
    const text = chunk.toString('utf8').trimEnd()
    if (!text) return
    for (const line of text.split('\n')) {
      logger.info(`[${svc.manifest.id}] ${line}`)
    }
  }

  // ── 生命周期事件 ──────────────────────────────────
  private publish<E extends EventKey>(topic: E, payload: LifecyclePayload<E>): void {
    const eventPayload: EventPayload<E> = {
      ts: Date.now(),
      source: 'core',
      ...payload,
    } as EventPayload<E>
    this.options.bus.publish(topic as EventKey, eventPayload as unknown as EventPayload<EventKey>)
  }
}