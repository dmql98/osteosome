/**
 * LlmAdapter —— DSH 接缝（P2 §3.2；WS-4 迁移 provider 为独立服务后本接口退场）。
 *
 * - `stream()` 是唯一异步入口：消费 native wire → yield `StreamChunk`（block 三段式）。
 * - 每个 provider 一个实现，负责把 provider 原生 finishReason / usage / 错误码映射到中立协议。
 * - 不引 axios / openai 官方 SDK：只 `fetch` + 原生 API（Node ≥ 18）。
 * - 协议类型统一从 `@osteosome/shared` 取（唯一真相源，不本地重复定义）。
 */
import type { RetryPolicy, StreamChunk, Usage, FinishReason } from '@osteosome/shared'

export type { RetryPolicy, StreamChunk, Usage, FinishReason }

// ── 从 shared 转导出的协议类型（避免双真相源）──
export type { StreamErrorCode, StreamError } from '@osteosome/shared'
export { normalizeFinishReason, normalizeUsage } from '@osteosome/shared'

export interface LlmRequest {
  /** routeKey（registry 路由），如 'openrouter' */
  provider: string
  /** 缺省用 adapter.defaultModel */
  model?: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  /** 调用方透传（含 requestId 溯源） */
  meta?: Record<string, unknown>
}

export interface LlmAdapterContext {
  /** 由 credentials/resolver 解析后注入（进程外不落盘） */
  apiKey: string
  /** 声明式；P2 只声明不执行 */
  retryPolicy: RetryPolicy
  signal?: AbortSignal
}

export interface LlmAdapter {
  readonly provider: string
  readonly defaultModel: string
  stream(req: LlmRequest, ctx: LlmAdapterContext): AsyncIterable<StreamChunk>
}
