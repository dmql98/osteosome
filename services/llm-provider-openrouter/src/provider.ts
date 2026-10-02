/**
 * llm-provider-openrouter —— provider 能力位纯逻辑（P2 WS-5）。
 *
 * 与 Service 装配解耦：`streamCompletions()` 消费 openai 兼容 wire → yield StreamChunk，
 * 错误码化 / usage 归一全部在此层（对齐旧 adapter 语义，迁移后不变）。
 */
import { normalizeFinishReason, normalizeUsage, readSseJson, type StreamChunk, type StreamError, type RetryPolicy, type ThinkingEffort } from '@osteosome/shared'

export const PROVIDER = 'openrouter'
export const DEFAULT_MODEL = 'openai/gpt-4o-mini'
export const CREDENTIAL_REF = 'env:OPENROUTER_API_KEY'
export const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** P2 只声明不执行；429/503 视为瞬态（对齐 §3.3 retryableCodes） */
/** 模型目录（P4 WS-3）：上游 /models 根 + 静态兜底列表（拉取失败时降级用） */
export const MODELS_BASE_URL = 'https://openrouter.ai/api/v1'
export const STATIC_MODELS = ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash']

export const RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoff: 'exponential',
  retryableCodes: ['rate_limited', 'server_error'],
}

export interface StreamRequest {
  requestId: string
  model?: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  /** 思考强度（P4 WS-2）→ openrouter 透传 `reasoning_effort`（openai 兼容） */
  thinking?: ThinkingEffort
  signal?: AbortSignal
  apiKey: string
}

interface WireChoice { index: number; delta?: { content?: string | null; reasoning?: string | null }; finish_reason?: string | null }
interface WireChunk { choices?: WireChoice[]; usage?: unknown; error?: { message?: string; code?: string } }

function mapHttpError(status: number, bodyText: string): StreamError {
  switch (status) {
    case 401:
    case 403:
      return { code: 'unauthorized', message: `openrouter: HTTP ${status}` }
    case 429:
      return { code: 'rate_limited', message: `openrouter: HTTP 429` }
    default:
      if (status >= 500) return { code: 'server_error', message: `openrouter: HTTP ${status}` }
      return { code: 'invalid_request', message: `openrouter: HTTP ${status} ${bodyText.slice(0, 200)}` }
  }
}

/** 消费上游 SSE → yield StreamChunk（block 三段式 / finish；取消走成功路径 finish{stop}） */
export async function* streamCompletions(req: StreamRequest): AsyncGenerator<StreamChunk, void, void> {
  let res: Response
  try {
    res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model ?? DEFAULT_MODEL,
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.thinking && req.thinking !== 'off' ? { reasoning_effort: req.thinking } : {}),
        stream: true,
      }),
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal?.aborted) return
    yield { kind: 'finish', finishReason: 'error', error: { code: 'network', message: `openrouter: fetch failed: ${String(err)}` } }
    return
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    yield { kind: 'finish', finishReason: 'error', error: mapHttpError(res.status, bodyText) }
    return
  }

  let textId: string | null = null
  let reasoningId: string | null = null
  let seq = 0
  try {
    for await (const event of readSseJson(res.body, { signal: req.signal })) {
      if (event.done) break
      const data = event.data as WireChunk
      if (!data || typeof data !== 'object') continue
      if (data.error) {
        yield { kind: 'finish', finishReason: 'error', error: { code: 'invalid_request', message: `openrouter: ${data.error.message ?? 'unknown error'}` } }
        return
      }
      const choice = data.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
        if (reasoningId === null) {
          reasoningId = `r-${req.requestId}-${seq++}`
          yield { kind: 'block-start', id: reasoningId, blockType: 'reasoning', index: seq - 1 }
        }
        yield { kind: 'delta', id: reasoningId, blockType: 'reasoning', text: delta.reasoning }
      } else if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (textId === null) {
          textId = `t-${req.requestId}-${seq++}`
          yield { kind: 'block-start', id: textId, blockType: 'text', index: seq - 1 }
        }
        yield { kind: 'delta', id: textId, blockType: 'text', text: delta.content }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        if (textId !== null) yield { kind: 'block-end', id: textId, blockType: 'text' }
        if (reasoningId !== null) yield { kind: 'block-end', id: reasoningId, blockType: 'reasoning' }
        const finalUsage = normalizeUsage(data.usage)
        yield { kind: 'finish', finishReason: normalizeFinishReason(choice.finish_reason), ...(finalUsage ? { usage: finalUsage } : {}) }
        return
      }
    }
    if (textId !== null) yield { kind: 'block-end', id: textId, blockType: 'text' }
    if (reasoningId !== null) yield { kind: 'block-end', id: reasoningId, blockType: 'reasoning' }
    yield { kind: 'finish', finishReason: 'stop' }
  } catch (err) {
    if (req.signal?.aborted) return
    yield { kind: 'finish', finishReason: 'error', error: { code: 'network', message: `openrouter: stream error: ${String(err)}` } }
  }
}
