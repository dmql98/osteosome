/**
 * OpenRouter 适配器（P2 能力位拆分前的过渡实现；WS-4 迁移为独立 `llm-provider-openrouter` 服务）。
 *
 * - wire：OpenAI 兼容 `POST {baseURL}/chat/completions` SSE（`https://openrouter.ai/api/v1`）。
 * - 翻译：`choices[].delta.content` → text delta；`delta.reasoning`（OpenRouter 推理模型）→ reasoning 块（P2 只翻译不渲染）；
 *   `finish_reason` / `[DONE]` → finish 块。
 * - usage 归一：`prompt_tokens` / `completion_tokens` → `Usage.promptTokens / completionTokens`（P2 只填总量）。
 * - 错误码化：401/403 → `unauthorized`；429 → `rate_limited`；5xx → `server_error`；网络 → `network`；400/wire 畸形 → `invalid_request`。
 */
import {
  normalizeFinishReason,
  normalizeUsage,
  readSseJson,
  type StreamChunk,
  type StreamError,
} from '@osteosome/shared'
import type { RetryPolicy } from '@osteosome/shared'
import type { LlmAdapter } from './types'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini'

/** P2 只声明不执行；429/503 视为瞬态（对齐 §3.3 retryableCodes） */
export const OPENROUTER_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoff: 'exponential',
  retryableCodes: ['rate_limited', 'server_error'],
}

interface OpenRouterDelta {
  content?: string | null
  reasoning?: string | null
}

interface OpenRouterChoice {
  index: number
  delta?: OpenRouterDelta
  finish_reason?: string | null
}

interface OpenRouterChunk {
  choices?: OpenRouterChoice[]
  usage?: unknown
  error?: { message?: string; code?: string }
}

function mapHttpError(status: number, bodyText: string): StreamError {
  switch (status) {
    case 401:
    case 403:
      return { code: 'unauthorized', message: `openrouter: HTTP ${status}` }
    case 429:
      return { code: 'rate_limited', message: `openrouter: HTTP 429` }
    default:
      if (status >= 500) {
        return { code: 'server_error', message: `openrouter: HTTP ${status}` }
      }
      return {
        code: 'invalid_request',
        message: `openrouter: HTTP ${status} ${bodyText.slice(0, 200)}`,
      }
  }
}

export const openrouterAdapter: LlmAdapter = {
  provider: 'openrouter',
  defaultModel: OPENROUTER_DEFAULT_MODEL,

  async *stream(req, ctx) {
    const model = req.model ?? OPENROUTER_DEFAULT_MODEL
    const url = `${OPENROUTER_BASE_URL}/chat/completions`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stream: true,
        }),
        signal: ctx.signal,
      })
    } catch (err) {
      // AbortError 不是失败：取消走成功路径（服务侧发 finish{stop}）
      if (ctx.signal?.aborted) return
      yield {
        kind: 'finish',
        finishReason: 'error',
        error: { code: 'network', message: `openrouter: fetch failed: ${String(err)}` },
      }
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
      for await (const event of readSseJson(res.body, { signal: ctx.signal })) {
        if (event.done) break
        const data = event.data as OpenRouterChunk
        if (!data || typeof data !== 'object') continue
        // wire 级错误段（OpenRouter 错误也可能出现在 200 响应体内）
        if (data.error) {
          yield {
            kind: 'finish',
            finishReason: 'error',
            error: {
              code: 'invalid_request',
              message: `openrouter: ${data.error.message ?? 'unknown error'}`,
            },
          }
          return
        }
        const choice = data.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}

        if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          if (reasoningId === null) {
            reasoningId = `r-${req.meta?.requestId ?? 'x'}-${seq++}`
            yield { kind: 'block-start', id: reasoningId, blockType: 'reasoning', index: seq - 1 }
          }
          yield { kind: 'delta', id: reasoningId, blockType: 'reasoning', text: delta.reasoning }
        } else if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (textId === null) {
            textId = `t-${req.meta?.requestId ?? 'x'}-${seq++}`
            yield { kind: 'block-start', id: textId, blockType: 'text', index: seq - 1 }
          }
          yield { kind: 'delta', id: textId, blockType: 'text', text: delta.content }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          if (textId !== null) yield { kind: 'block-end', id: textId, blockType: 'text' }
          if (reasoningId !== null) yield { kind: 'block-end', id: reasoningId, blockType: 'reasoning' }
          const finalUsage = normalizeUsage(data.usage)
          yield {
            kind: 'finish',
            finishReason: normalizeFinishReason(choice.finish_reason),
            ...(finalUsage ? { usage: finalUsage } : {}),
          }
          return
        }
      }

      // 流自然结束（服务端未给 finish_reason / [DONE] 之外的收尾）
      if (textId !== null) yield { kind: 'block-end', id: textId, blockType: 'text' }
      if (reasoningId !== null) yield { kind: 'block-end', id: reasoningId, blockType: 'reasoning' }
      yield { kind: 'finish', finishReason: 'stop' }
    } catch (err) {
      if (ctx.signal?.aborted) return // 取消走成功路径
      yield {
        kind: 'finish',
        finishReason: 'error',
        error: { code: 'network', message: `openrouter: stream error: ${String(err)}` },
      }
    }
  },
}
