/**
 * Bus 类型（RFC §2）—— EventKey / EventPayload 从 shared 契约推导，
 * EventBase 必填 ts/source 由 Bus 归一化兜底。
 */
import type { EventBase } from '@osteosome/shared'

export type { EventBase, EventKey, EventPayload, CommandKey, CommandPayload } from '@osteosome/shared'
export type { EventMap, CommandMap } from '@osteosome/shared'

/** 总线上的一条事件（含持久化标记与序号） */
export interface EventRecord {
  /** 单调递增序号（发布顺序，replay 的定位依据） */
  seq: number
  topic: string
  /** 归一化后的 payload（必含 ts/source） */
  payload: Record<string, unknown>
  /** 是否进入持久化适配器 */
  persisted: boolean
}

/** publish 选项 */
export interface PublishOptions {
  /** 强制落库（缺省走 topic 前缀白名单） */
  persist?: boolean
}

/** subscribe 选项 */
export interface SubscribeOptions {
  /** 一次性订阅：触发一次后自动废除 */
  once?: boolean
  /** 数值越大越先执行（拦截型订阅） */
  priority?: number
  /** 过滤：返回 false 则跳过该订阅者 */
  filter?: (payload: Record<string, unknown>) => boolean
}