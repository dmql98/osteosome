/**
 * ServiceManager（RFC §3 / WS-3）—— 进程生命周期编排。
 *
 * - 启动：扫 manifest → 拓扑排序 → 逐个 spawn + initialize 握手 + 注册 + 心跳
 * - 生命周期事件：service.starting / ready / restarting / failed / stopped（带 ts/source）
 * - stdio JSON-RPC：Core 应答 initialize，受理 bus.publish / bus.subscribe / bus.unsubscribe /
 *   shutdown，按 topic 把事件推给对应服务（bus.event）
 * - 崩溃 / 协议错误 / 心跳超时 → 重启（backoff，超 maxRestarts → failed）
 */
import type { Bus } from '../bus/bus'
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
import { loadServices } from './manifest'
import { forceKill, sendSigterm, spawnServiceProcess, waitExit, type ManagedProcess } from './process'
import { topologicalOrder } from './topology'

const DEFAULT_STOP_GRACE_MS = 5000
const DEFAULT_BACKOFF_BASE_MS = 1000
const DEFAULT_CONSECUTIVE_HEALTH_FAILURES = 3

interface HandshakeWaiter {
  resolve: (params: InitializeParams) => void
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
  handshakeWaiter?: HandshakeWaiter
}

export interface ServiceManagerOptions {
  servicesDir: string
  dataDir: string
  sessionId: string
  bus: Bus
  handshakeTimeoutMs?: number
  stopGraceMs?: number
  maxRestarts?: number
  backoffBaseMs?: number
  consecutiveHealthFailures?: number
  /** 可注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>
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

  async start(): Promise<void> {
    await this.options.bus.ready()
    const loaded = loadServices(this.options.servicesDir)
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
      await this.spawnAndHandshake(svc)
    }
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
      })
    }
    return out
  }

  // ── 启动/握手 ─────────────────────────────────────
  private async spawnAndHandshake(svc: ManagedService): Promise<void> {
    const spawned = this.spawnService(svc)
    try {
      const params = await this.armHandshake(svc)
      this.readyService(svc, params)
    } catch (err) {
      logger.error(`[${svc.manifest.id}] handshake failed: ${String(err)}`)
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

  private readyService(svc: ManagedService, params: InitializeParams): void {
    const manifest = svc.manifest
    this.verifyInitialize(svc, params)
    svc.status = 'ready'
    svc.protocolFailedReason = undefined
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
          this.options.bus.publish(topic, { ...(payload ?? {}), source: svc.manifest.id })
          return { ok: true }
        }
        case 'bus.subscribe': {
          const { topic } = (params ?? {}) as { topic?: string }
          if (typeof topic !== 'string') throw jsonRpcError(-32602, 'bus.subscribe: topic required')
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
        default:
          throw jsonRpcError(-32601, `method not found: ${method}`)
      }
    }
    client.onNotification = (method) => {
      switch (method) {
        case 'health.pong':
          svc.health?.confirm()
          break
        case 'initialized':
          break
        case 'shutdown':
          void this.stopService(svc, this.stopGraceMs)
          break
        default:
          logger.debug(`[${svc.manifest.id}] unhandled notification: ${method}`)
      }
    }
    client.onError = (err) => this.onProtocolError(svc, err)
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
          dataDir: this.options.dataDir,
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
    }

    const budget = svc.manifest.restartPolicy?.maxRestarts ?? this.maxRestarts
    if (svc.restartCount >= budget) {
      if (reason === undefined) {
        this.publish('service.failed', {
          serviceId: svc.manifest.id,
          ...(code != null ? { exitCode: code } : {}),
          reason: `max restarts (${budget}) exceeded; ${exitInfo}${override !== undefined ? `; ${override}` : ''}`,
        })
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