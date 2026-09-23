/**
 * Bus —— 消息总线（RFC §2 / P1a WS-2）。
 *
 * 语义：
 * - publish 同步返回、异步投递（微任务 drain）
 * - 错误隔离：handler 抛错 → 日志 → 继续下一个订阅者
 * - 背压：队列上限（默认 10000），超限丢最旧并计 stats.dropped
 * - 持久化：persist:true 或 topic 前缀白名单落库；Memory / Null 适配器
 * - 订阅 disposer：调用即取消（可回卷效果的基础）
 * - priority：数值越大越先执行；once / filter 支持
 */
import type { CommandKey, CommandPayload, EventKey, EventPayload } from '@osteosome/shared'
import { logger } from '../logger'
import { matchPattern } from './pattern'
import { NullAdapter, type PersistenceAdapter } from './persistence'
import type { EventRecord, PublishOptions, SubscribeOptions } from './types'

export interface BusStats {
  published: number
  delivered: number
  dropped: number
}

export interface BusOptions {
  adapter?: PersistenceAdapter
  /** 背压队列上限（默认 10000） */
  maxQueueSize?: number
  /** 持久化白名单前缀（默认 ['service.']，RFC 白名单：llm./loop./service.） */
  persistPrefixes?: string[]
}

interface Subscription {
  pattern: string
  handler: (payload: Record<string, unknown>, topic: string) => unknown
  once: boolean
  priority: number
  filter?: (payload: Record<string, unknown>) => boolean
  disposed: boolean
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  if (typeof out.ts !== 'number') out.ts = Date.now()
  if (typeof out.source !== 'string') out.source = 'core'
  return out
}

export class Bus {
  private subscriptions: Subscription[] = []
  private queue: EventRecord[] = []
  private drainScheduled = false
  private seq = 0
  private stats: BusStats = { published: 0, delivered: 0, dropped: 0 }
  private readonly maxQueueSize: number
  private readonly persistPrefixes: string[]
  private adapter: PersistenceAdapter

  constructor(options: BusOptions = {}) {
    this.adapter = options.adapter ?? new NullAdapter()
    this.maxQueueSize = options.maxQueueSize ?? 10000
    this.persistPrefixes = options.persistPrefixes ?? ['service.']
  }

  // ── 发布 ─────────────────────────────────────────
  publish<T extends string>(
    topic: T,
    payload: T extends EventKey ? EventPayload<T> : T extends CommandKey ? CommandPayload<T> : unknown,
    options: PublishOptions = {},
  ): void {
    // 不变式：payload 必须 JSON 可序列化（无函数 / Symbol / 循环引用）
    let normalized: Record<string, unknown>
    try {
      const candidate = normalizePayload(payload)
      JSON.stringify(candidate)
      normalized = candidate
    } catch (err) {
      logger.error(`bus: payload not JSON-serializable [${topic}]`, String(err))
      return
    }

    const shouldPersist = options.persist === true || this.persistPrefixes.some((p) => topic.startsWith(p))
    const record: EventRecord = { seq: ++this.seq, topic, payload: normalized, persisted: false }

    if (shouldPersist) {
      record.persisted = true
      this.adapter.append(record).catch((err) => {
        logger.error(`bus: persistence append failed [${topic}]`, String(err))
      })
    }

    this.stats.published++
    this.enqueue(record)
  }

  // ── 订阅 ─────────────────────────────────────────
  subscribe<T extends string>(
    topic: T,
    handler: (
      payload: T extends EventKey ? EventPayload<T> : T extends CommandKey ? CommandPayload<T> : Record<string, unknown>,
      topic: T,
    ) => unknown,
    options: SubscribeOptions = {},
  ): () => void {
    const sub: Subscription = {
      pattern: topic,
      handler: handler as Subscription['handler'],
      once: options.once ?? false,
      priority: options.priority ?? 0,
      filter: options.filter,
      disposed: false,
    }
    this.subscriptions.push(sub)
    return () => {
      if (sub.disposed) return
      sub.disposed = true
      const idx = this.subscriptions.indexOf(sub)
      if (idx >= 0) this.subscriptions.splice(idx, 1)
    }
  }

  // ── 回放 ─────────────────────────────────────────
  async *replay(from: number, to: number, topics?: string[]): AsyncIterable<EventRecord> {
    yield* this.adapter.range(from, to, topics)
  }

  // ── 元信息 ───────────────────────────────────────
  statsSnapshot(): BusStats {
    return { ...this.stats }
  }

  async ready(): Promise<void> {
    /* P1a 适配器（Memory / Null）即刻可用；SQLite(P8) 落地后在此 await 初始化 */
  }

  async close(): Promise<void> {
    this.queue = []
    await this.adapter.close()
  }

  // ── 内部 ─────────────────────────────────────────
  private enqueue(record: EventRecord): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift()
      this.stats.dropped++
      logger.warn(`bus: backpressure dropped oldest event [${record.topic}] (queue full: ${this.maxQueueSize})`)
    }
    this.queue.push(record)
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const record = this.queue.shift()!
      this.deliver(record)
    }
  }

  private deliver(record: EventRecord): void {
    const matched = this.subscriptions.filter(
      (s) => !s.disposed && matchPattern(s.pattern, record.topic),
    )
    matched.sort((a, b) => b.priority - a.priority)

    for (const sub of matched) {
      if (sub.disposed) continue
      if (sub.filter && !sub.filter(record.payload)) continue
      try {
        const result = sub.handler(record.payload, record.topic)
        this.stats.delivered++
        if (result instanceof Promise) {
          result.catch((err) => {
            logger.error(`bus: async handler error [${record.topic}]`, String(err))
          })
        }
      } catch (err) {
        // 错误隔离：单个订阅者抛错不中断其余投递
        logger.error(`bus: handler error [${record.topic}]`, String(err))
        continue
      }
      if (sub.once && !sub.disposed) {
        sub.disposed = true
        const idx = this.subscriptions.indexOf(sub)
        if (idx >= 0) this.subscriptions.splice(idx, 1)
      }
    }
  }
}