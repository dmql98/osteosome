/**
 * 持久化适配器（RFC §2.3）—— P1a 提供 Memory / Null 两种，SQLite 延后 P8。
 * 接口预留 SqliteAdapter。
 */
import type { EventRecord } from './types'

export interface PersistenceAdapter {
  append(event: EventRecord): Promise<void>
  range(from: number, to: number, topics?: string[]): AsyncIterable<EventRecord>
  close(): Promise<void>
}

/** 内存适配器 —— 测试 / P1a 默认；数组存储，replay 保序 */
export class MemoryAdapter implements PersistenceAdapter {
  private events: EventRecord[] = []

  async append(event: EventRecord): Promise<void> {
    this.events.push(event)
  }

  async *range(from: number, to: number, topics?: string[]): AsyncIterable<EventRecord> {
    for (const ev of this.events) {
      if (ev.seq < from || ev.seq > to) continue
      if (topics && topics.length > 0 && !topics.includes(ev.topic)) continue
      yield ev
    }
  }

  async close(): Promise<void> {
    this.events = []
  }

  get size(): number {
    return this.events.length
  }
}

/** 空适配器 —— 不落库。P1a 显式决策：SQLite 延后，落库失败写 TODO(P8)，不留静默数据丢失 */
export class NullAdapter implements PersistenceAdapter {
  // TODO(P8)：替换为 SqliteAdapter。当前为显式"不持久化"，日志告知即可，无静默丢数据诉求（无数据可丢）。
  async append(_event: EventRecord): Promise<void> {
    /* 显式不落库 */
  }

  async *range(_from: number, _to: number, _topics?: string[]): AsyncIterable<EventRecord> {
    return
  }

  async close(): Promise<void> {
    /* no-op */
  }
}