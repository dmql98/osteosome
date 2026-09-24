/**
 * Service 运行时（RFC §6.3 / P1a WS-5）—— 服务进程的统一入口。
 *
 * - `new Service({ id, version })` → `await service.start()`（握手 + 心跳 + 路由）
 * - `service.subscribe(topic, handler)` **返回 disposer**（与 Bus 一致；进程退出前自动调用）
 * - `service.publish(topic, payload)` → `bus.publish`（亦暴露 `service.bus.publish`）
 * - **`service.dataDir`**：握手响应带回的数据根（P1a §3.1）
 * - SIGTERM/SIGINT 优雅退出：停止接收 → 等 in-flight → `shutdown` → exit
 * - Core 下发 `shutdown` / `bus.event` / `health.ping` 由本模块路由
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { METHODS, PROTOCOL_VERSION, type InitializeResult } from '@osteosome/shared'
import { performHandshake } from './handshake'
import { attachHeartbeat } from './heartbeat'
import { logger } from './logger'
import { RpcPeer, StreamTransport, createStdioTransport, type Transport } from './transport'

/** 订阅回调（payload 已含 Core 归一化的 ts/source） */
export type ServiceHandler = (payload: Record<string, unknown>, topic: string) => unknown

export interface ServiceOptions {
  id: string
  version: string
  /** manifest 快照；缺省则从 `manifestPath` 或 `cwd/service.json` 读取 */
  manifest?: Record<string, unknown>
  manifestPath?: string
  /** 注入传输（测试用 PassThrough）；缺省 stdio */
  transport?: Transport
  /** 是否安装 SIGTERM/SIGINT 优雅退出（测试可关；默认 true） */
  handleSignals?: boolean
  /** 进程退出出口（测试注入；默认 process.exit） */
  exit?: (code: number) => void
  /** 握手参数覆盖（测试调超时/重试） */
  handshake?: {
    timeoutMs?: number
    retries?: number
    retryDelayMs?: number
    coreVersion?: string
    protocolVersion?: string
  }
  /** JSON-RPC 请求默认超时 ms */
  requestTimeoutMs?: number
}

/** 通配符匹配（与 Core bus/pattern 同规范、独立实现）：`*` 一段 / `**` 多段 / 裸 `*` 全量 */
function matchPattern(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  return matchSegments(pattern.split('.'), topic.split('.'))
}

function matchSegments(pat: string[], topic: string[]): boolean {
  if (pat.length === 0) return topic.length === 0
  const head = pat[0]
  if (head === '**') {
    for (let take = 0; take <= topic.length; take++) {
      if (matchSegments(pat.slice(1), topic.slice(take))) return true
    }
    return false
  }
  if (topic.length === 0) return false
  if (head === '*' || head === topic[0]) {
    return matchSegments(pat.slice(1), topic.slice(1))
  }
  return false
}

function loadManifest(options: ServiceOptions): Record<string, unknown> {
  if (options.manifest) return options.manifest
  const file =
    options.manifestPath ??
    (options.id ? path.join(process.cwd(), 'service.json') : undefined)
  if (file && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch (err) {
      throw new Error(`service: failed to read manifest ${file}: ${String(err)}`)
    }
  }
  // 无磁盘 manifest：最小快照（Core 侧会与磁盘交叉校验，生产服务应带 service.json）
  return {
    id: options.id,
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
    publishes: [],
    subscribes: [],
  }
}

export class Service {
  /** 握手响应带回的数据根（start() 前为 ''） */
  dataDir = ''
  /** 握手响应的 sessionId */
  sessionId = ''
  /** Core 权威心跳间隔（manifest.healthCheck.interval 回发） */
  heartbeatInterval = 0
  /** 服务 manifest 快照（initialize params 用） */
  readonly manifest: Record<string, unknown>

  readonly bus: { publish: (topic: string, payload?: Record<string, unknown>) => void }

  private readonly rpc: RpcPeer
  private readonly handlers = new Map<string, Set<ServiceHandler>>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly disposers: Array<() => void> = []
  private readonly options: ServiceOptions
  private stopping = false
  private started = false
  private stopPromise: Promise<void> | null = null
  private signalCleanup: (() => void) | null = null

  constructor(options: ServiceOptions) {
    this.options = options
    this.manifest = loadManifest(options)
    const transport = options.transport ?? createStdioTransport()
    this.rpc = new RpcPeer(transport, {
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    })
    this.bus = {
      publish: (topic, payload) => this.publish(topic, payload),
    }
  }

  get id(): string {
    return this.options.id
  }

  get version(): string {
    return this.options.version
  }

  /** 启动：握手（initialize/initialized）→ 挂心跳 → 路由 bus.event/shutdown → 可选信号处理 */
  async start(): Promise<InitializeResult> {
    if (this.started) throw new Error('service: already started')
    const hs = this.options.handshake ?? {}
    const result = await performHandshake(this.rpc, {
      serviceId: this.options.id,
      version: this.options.version,
      manifest: this.manifest,
      ...hs,
    })
    this.dataDir = result.dataDir
    this.sessionId = result.sessionId
    this.heartbeatInterval = result.heartbeatInterval
    this.started = true

    this.disposers.push(attachHeartbeat(this.rpc))
    this.disposers.push(
      this.rpc.onNotification((method, params) => {
        if (method === METHODS['bus.event']) {
          this.dispatchEvent(params)
        } else if (method === METHODS.shutdown) {
          void this.handleRemoteShutdown()
        }
      }),
    )

    // start() 之前注册的本地订阅：握手成功后向 Core 补发 bus.subscribe
    for (const topic of this.handlers.keys()) {
      this.busRequest(METHODS['bus.subscribe'], { topic })
    }
    // 只有本地订阅已经写入 Core 的请求队列后，才确认 initialized。
    this.rpc.notify(METHODS.initialized)

    if (this.options.handleSignals !== false) {
      this.installSignalHandlers()
    }

    logger.info(`service '${this.id}' started session=${this.sessionId} dataDir=${this.dataDir}`)
    return result
  }

  /**
   * 订阅 topic（可为通配 pattern，Core 侧过滤）；返回 disposer。
   * 首次订阅某 pattern 时向 Core 发 `bus.subscribe`；最后一个 handler 摘除时发 `bus.unsubscribe`。
   * 进程退出前 Service 会自动调用全部 disposer。
   */
  subscribe(topic: string, handler: ServiceHandler): () => void {
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
      // Core 只在 onRequest（带 id 的请求）里受理 bus.* —— 用 notify 会被当未处理通知丢弃
      if (this.started && !this.stopping) this.busRequest(METHODS['bus.subscribe'], { topic })
    }
    set.add(handler)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.handlers.get(topic)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) {
        this.handlers.delete(topic)
        if (this.started && !this.stopping) {
          this.busRequest(METHODS['bus.unsubscribe'], { topic })
        }
      }
    }
  }

  /** 发布事件到 Core 总线（亦见 {@link bus.publish}） */
  publish(topic: string, payload: Record<string, unknown> = {}): void {
    if (!this.started || this.stopping) {
      logger.warn(`publish dropped (not running): [${topic}]`)
      return
    }
    this.busRequest(METHODS['bus.publish'], { topic, payload })
  }

  /** bus.* 一律走带 id 的请求（Core onRequest 受理）；失败只记日志不抛 */
  private busRequest(method: string, params: unknown): void {
    void this.rpc.request(method, params).catch((err) => {
      // stop() 期间 unsubscribe 的响应等不到就关连接了 —— 帧已同步写入管道，不告警
      if (!this.stopping) logger.warn(`${method} failed: ${String(err)}`)
    })
  }

  /**
   * 优雅退出：停止接收 → 摘除订阅 → 等 in-flight 完成 → 可选 notify `shutdown`。
   * 不调用 process.exit（信号/远端 shutdown 路径在外层收口）。
   * 并发调用共享同一次停止（第二个调用者 await 首个调用的完成）。
   */
  stop(options: { notifyShutdown?: boolean } = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.doStop(options)
    return this.stopPromise
  }

  private async doStop(options: { notifyShutdown?: boolean }): Promise<void> {
    this.stopping = true

    // 停止接收：摘掉全部本地订阅（不再派发 bus.event）
    const subscribedTopics = [...this.handlers.keys()]
    for (const set of this.handlers.values()) set.clear()
    this.handlers.clear()

    // 摘挂接（heartbeat / notification 路由 / 信号）
    for (const d of this.disposers.splice(0)) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    this.signalCleanup?.()
    this.signalCleanup = null

    // 等 in-flight handler 完成
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }

    // 向 Core 退订（Core 不随进程退出自动清订阅；先退订再 shutdown 保证线上顺序）
    if (this.started) {
      for (const topic of subscribedTopics) {
        this.busRequest(METHODS['bus.unsubscribe'], { topic })
      }
    }

    if (options.notifyShutdown && this.started) {
      try {
        this.rpc.notify(METHODS.shutdown)
      } catch {
        /* transport 可能已关 */
      }
    }

    this.started = false
    this.rpc.close()
    logger.info(`service '${this.id}' stopped`)
  }

  /** 便捷别名：`bus.publish` 语义与 Core Bus 对齐 */
  // （this.bus 已在构造器绑定）

  // ── 内部 ──────────────────────────────────────

  private dispatchEvent(params: unknown): void {
    if (this.stopping) return
    const p = params as { topic?: unknown; payload?: unknown } | null
    if (!p || typeof p.topic !== 'string') return
    const topic = p.topic
    const payload =
      p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload)
        ? (p.payload as Record<string, unknown>)
        : {}

    for (const [pattern, set] of this.handlers) {
      if (!matchPattern(pattern, topic)) continue
      for (const handler of set) {
        try {
          const result = handler(payload, topic)
          if (result instanceof Promise) {
            const tracked = result
              .catch((err) => {
                logger.error(`handler error [${topic}]`, String(err))
              })
              .then(() => undefined) as Promise<void>
            this.inFlight.add(tracked)
            void tracked.finally(() => this.inFlight.delete(tracked))
          }
        } catch (err) {
          // 错误隔离：单个 handler 抛错不中断其余
          logger.error(`handler error [${topic}]`, String(err))
        }
      }
    }
  }

  private async handleRemoteShutdown(): Promise<void> {
    logger.info(`service '${this.id}' received shutdown from Core`)
    await this.stop({ notifyShutdown: false })
    const exit = this.options.exit ?? ((c: number) => process.exit(c))
    exit(0)
  }

  private installSignalHandlers(): void {
    const onSignal = () => {
      logger.info(`service '${this.id}' signal received, graceful stop`)
      void this.stop({ notifyShutdown: true }).then(() => {
        const exit = this.options.exit ?? ((c: number) => process.exit(c))
        exit(0)
      })
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    this.signalCleanup = () => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
    }
  }
}
