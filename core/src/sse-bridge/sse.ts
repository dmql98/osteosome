/**
 * SSE 连接会话（RFC §4 / P1a WS-4 补强 ②）。
 *
 * - 每连接 = 一个过滤后的 Bus 订阅（裸 `*` 订阅 + `?topics=` 通配过滤）
 * - 统一 `event: message`，body 为 `{ topic, payload }`
 * - 心跳注释行 `: heartbeat`（默认 30s）；连接关闭 → dispose 订阅
 * - 90s 无有效写 → 主动断僵尸连接（TCP 静默断开兜底，客户端 EventSource 重连）
 * - `Last-Event-ID` 头预留（P8 bus.replay 接线点，P1a 只读不消费）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Bus } from '../bus/bus'
import { matchPattern } from '../bus/pattern'

/** 单连接会话参数（heartbeatMs/zombieMs 可注入以便测试） */
export interface SseSessionOptions {
  /** 心跳间隔 ms；`<= 0` 或非有限值 = 禁用 */
  heartbeatMs: number
  /** 无有效写超过该时长则断开；`<= 0` = 禁用僵尸检测 */
  zombieMs: number
  /** topic 过滤（支持 `*` / `**` 通配）；空数组 = 全部 */
  topics: string[]
  /** 客户端 Last-Event-ID（预留，P1a 不消费） */
  lastEventId?: string
}

/** 默认心跳：30s（注释行保活 + 刷新 lastOkAt） */
export const DEFAULT_HEARTBEAT_MS = 30_000

/** 默认僵尸阈值：90s 无有效写（补强 ②） */
export const DEFAULT_ZOMBIE_MS = 90_000

/** 解析 `?topics=a,b.*` → 模式数组（去空；空/缺省 = [] 表示不过滤） */
export function parseTopics(search: string): string[] {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const raw = params.get('topics')
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 单条 SSE 会话：订阅 → 推流 → 心跳/僵尸看门狗 → 关闭时 dispose */
export class SseSession {
  private disposeBus: (() => void) | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private zombieTimer: NodeJS.Timeout | null = null
  private lastOkAt = Date.now()
  private closed = false
  /** Node response 缓冲满时，后续事件暂存；达到上限主动断开慢客户端。 */
  private pendingWrites: string[] = []
  private writeBlocked = false
  private readonly maxPendingWrites = 1000

  /** 连接关闭时回调（server 从连接表移除） */
  onClosed: (() => void) | null = null

  constructor(
    private readonly res: ServerResponse,
    private readonly bus: Bus,
    private readonly options: SseSessionOptions,
  ) {}

  /** 开启流：写响应头 → 订阅 Bus → 启动看门狗 */
  start(req: IncomingMessage): void {
    if (this.closed) return

    // Last-Event-ID 预留：读而不消费（P8 接 bus.replay）
    const lastEventId = req.headers['last-event-id']
    if (typeof lastEventId === 'string' && lastEventId !== '') {
      this.options.lastEventId = lastEventId
    }

    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // 反代缓冲禁用（X-Accel-Buffering）
      'X-Accel-Buffering': 'no',
    })
    // flush 头 + 初始注释，让 EventSource 尽快收到 open
    this.write(': connected\n\n')
    this.lastOkAt = Date.now()

    const { topics } = this.options
    this.disposeBus = this.bus.subscribe('*', (payload, topic) => {
      if (this.closed) return
      if (topics.length > 0 && !topics.some((t) => matchPattern(t, topic))) return
      this.write(`event: message\ndata: ${JSON.stringify({ topic, payload })}\n\n`)
    })

    if (Number.isFinite(this.options.heartbeatMs) && this.options.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.options.heartbeatMs)
      this.heartbeatTimer.unref?.()
    }

    if (Number.isFinite(this.options.zombieMs) && this.options.zombieMs > 0) {
      // 检查频率取 zombieMs 的约数档，测试注入小值也能及时触发
      const checkEvery = Math.max(10, Math.floor(this.options.zombieMs / 3))
      this.zombieTimer = setInterval(() => this.checkZombie(), checkEvery)
      this.zombieTimer.unref?.()
    }

    this.res.on('close', () => this.close())
    this.res.on('error', () => this.close())
  }

  /** 关闭会话：幂等；dispose 订阅 + 清定时器 + 通知 server */
  close(): void {
    if (this.closed) return
    this.closed = true

    this.pendingWrites.length = 0
    this.writeBlocked = false
    this.disposeBus?.()
    this.disposeBus = null

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.zombieTimer) {
      clearInterval(this.zombieTimer)
      this.zombieTimer = null
    }

    if (!this.res.writableEnded && !this.res.destroyed) {
      this.res.end()
    }
    this.onClosed?.()
  }

  /** 是否仍活跃（供 server.connectionCount） */
  get active(): boolean {
    return !this.closed
  }

  private heartbeat(): void {
    if (this.closed) return
    this.write(': heartbeat\n\n')
  }

  private checkZombie(): void {
    if (this.closed) return
    if (Date.now() - this.lastOkAt > this.options.zombieMs) {
      // TCP 静默断开兜底：主动断，客户端 EventSource 自动重连
      this.close()
    }
  }

  /** 写一帧；成功回调刷新 lastOkAt（失败 = 对端可能已死，留给僵尸检查） */
  private write(chunk: string): void {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return
    if (this.writeBlocked) {
      if (this.pendingWrites.length >= this.maxPendingWrites) {
        this.close()
        return
      }
      this.pendingWrites.push(chunk)
      return
    }

    const accepted = this.res.write(chunk, (err) => {
      if (err) return
      this.lastOkAt = Date.now()
    })
    if (!accepted) {
      this.writeBlocked = true
      this.res.once('drain', () => {
        if (this.closed) return
        this.writeBlocked = false
        this.flushPending()
      })
    }
  }

  private flushPending(): void {
    while (!this.closed && !this.writeBlocked && this.pendingWrites.length > 0) {
      const next = this.pendingWrites.shift()!
      this.write(next)
    }
  }
}
