/**
 * llm-provider-openai —— 通用 openai 兼容 provider 能力位纯逻辑（P2 WS-6）。
 *
 * 与 WS-5 的 deepseek/openrouter 同构：消费 openai 兼容 `/chat/completions` SSE → StreamChunk。
 * 差异仅两点（这正是「通用一键接入」的含义）：
 * - baseURL 经 env 可配（`OPENAI_BASE_URL`，默认 `https://api.openai.com/v1`），
 *   任意 openai 兼容端点（openrouter / vLLM / Ollama / LM Studio …）改环境变量即接入；
 * - 可选附加 header（`OPENAI_EXTRA_HEADERS` JSON），供需要 `HTTP-Referer` / `X-Title` 的端点。
 */
import {
  normalizeFinishReason,
  normalizeUsage,
  readSseJson,
  type StreamChunk,
  type StreamError,
  type RetryPolicy,
  type ThinkingEffort,
} from '@osteosome/shared'

export const PROVIDER = 'openai'
export const CREDENTIAL_REF = 'env:OPENAI_API_KEY'

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL_NAME = 'gpt-4o-mini'

/** env 解析：baseURL（去尾部 `/`，兼容 `…/v1/` 写法） */
export function resolveBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.OPENAI_BASE_URL?.trim()
  return v && v.length > 0 ? v.replace(/\/+$/, '') : DEFAULT_BASE_URL
}

/** env 解析：默认模型 */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.OPENAI_MODEL?.trim()
  return v && v.length > 0 ? v : DEFAULT_MODEL_NAME
}

/** env 解析：附加 header（JSON 对象；畸形/非对象静默回退空） */
export function resolveExtraHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.OPENAI_EXTRA_HEADERS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
      ) as Record<string, string>
    }
  } catch {
    /* ignore malformed JSON */
  }
  return {}
}

export const DEFAULT_MODEL = resolveDefaultModel()
export const BASE_URL = resolveBaseURL()
export const EXTRA_HEADERS = resolveExtraHeaders()

/** 模型目录静态兜底（P4 WS-3） */
export const STATIC_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini']

/** P2 只声明不执行；429/503 视为瞬态（对齐 §3.3 retryableCodes） */
export const RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoff: 'exponential',
  retryableCodes: ['rate_limited', 'server_error'],
}

/** openai 兼容工具定义（原样透传上游，不解释语义） */
export type ToolSpec = Record<string, unknown>

export interface StreamRequest {
  requestId: string
  model?: string
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }[]
  temperature?: number
  signal?: AbortSignal
  apiKey: string
  /** 覆盖默认 baseURL（测试 / 运行期自定义） */
  baseURL?: string
  /** 合并到默认 EXTRA_HEADERS 之上的附加 header */
  extraHeaders?: Record<string, string>
  /** 思考强度（P4 WS-2 中立枚举）→ wire `reasoning_effort`（`off` 不下发，用模型默认） */
  thinking?: ThinkingEffort
  /** 工具定义（非空即上送，让模型可发起 tool_calls —— P7 agent 循环的前提） */
  tools?: ToolSpec[]
}

/** wire 层工具调用增量（openai 兼容形状：`delta.tool_calls[]`，按 `index` 分片累积） */
interface WireToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface WireChoice {
  index: number
  delta?: { content?: string | null; reasoning?: string | null; tool_calls?: WireToolCallDelta[] }
  finish_reason?: string | null
}
interface WireChunk {
  choices?: WireChoice[]
  usage?: unknown
  error?: { message?: string; code?: string }
}

function mapHttpError(status: number, bodyText: string): StreamError {
  switch (status) {
    case 401:
    case 403:
      return { code: 'unauthorized', message: `openai: HTTP ${status}` }
    case 429:
      return { code: 'rate_limited', message: `openai: HTTP 429` }
    default:
      if (status >= 500) return { code: 'server_error', message: `openai: HTTP ${status}` }
      return {
        code: 'invalid_request',
        message: `openai: HTTP ${status} ${bodyText.slice(0, 200)}`,
      }
  }
}

/** 消费上游 SSE → yield StreamChunk（block 三段式 / finish；取消走成功路径 finish{stop}） */
export async function* streamCompletions(req: StreamRequest): AsyncGenerator<StreamChunk, void, void> {
  const baseURL = req.baseURL ?? BASE_URL
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${req.apiKey}`,
    ...EXTRA_HEADERS,
    ...(req.extraHeaders ?? {}),
  }
  let res: Response
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model ?? DEFAULT_MODEL,
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        // 思考强度 → openai wire（`off` 不下发，避免覆盖模型默认档）
        ...(req.thinking && req.thinking !== 'off' ? { reasoning_effort: req.thinking } : {}),
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
        stream: true,
      }),
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal?.aborted) return
    yield { kind: 'finish', finishReason: 'error', error: { code: 'network', message: `openai: fetch failed: ${String(err)}` } }
    return
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    yield { kind: 'finish', finishReason: 'error', error: mapHttpError(res.status, bodyText) }
    return
  }

  let textId: string | null = null
  let reasoningId: string | null = null
  /** wire tool_calls[].index → 本地块 id（wire 同一 tool_call 分多帧累积 arguments） */
  const toolIds = new Map<number, string>()
  let seq = 0
  /** 收尾：关掉所有未闭合的块（text / reasoning / tool_call） */
  function* closeAll(): Generator<StreamChunk> {
    if (textId !== null) yield { kind: 'block-end', id: textId, blockType: 'text' }
    if (reasoningId !== null) yield { kind: 'block-end', id: reasoningId, blockType: 'reasoning' }
    for (const id of toolIds.values()) yield { kind: 'block-end', id, blockType: 'tool_call' }
  }

  try {
    for await (const event of readSseJson(res.body, { signal: req.signal })) {
      if (event.done) break
      const data = event.data as WireChunk
      if (!data || typeof data !== 'object') continue
      if (data.error) {
        yield {
          kind: 'finish',
          finishReason: 'error',
          error: { code: 'invalid_request', message: `openai: ${data.error.message ?? 'unknown error'}` },
        }
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
      // 工具调用增量：wire 按 tool_calls[].index 分片，name 只在首帧，arguments 分多帧累积
      for (const call of delta.tool_calls ?? []) {
        if (!call || typeof call.index !== 'number') continue
        let id = toolIds.get(call.index)
        if (id === undefined) {
          id = `c-${req.requestId}-${call.index}-${seq++}`
          toolIds.set(call.index, id)
          yield { kind: 'block-start', id, blockType: 'tool_call', index: seq - 1 }
        }
        const name = typeof call.function?.name === 'string' ? call.function.name : null
        const args = call.function?.arguments
        // 注意：openai 首帧把 name 与**空** arguments（''）放在同一帧。若只在 args 非空时 yield，
        // 工具名会被整段丢弃 → agent 知道要调工具却不知道调哪个。故 name 存在或 args 非空都要吐。
        if (name !== null || (typeof args === 'string' && args.length > 0)) {
          yield {
            kind: 'tool-arg-delta',
            id,
            blockType: 'tool_call',
            // name 只在首帧携带，后续为 null（块边界自带完整信息，调用方无需拼装）
            name,
            arguments: typeof args === 'string' ? args : '',
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        yield* closeAll()
        const finalUsage = normalizeUsage(data.usage)
        yield { kind: 'finish', finishReason: normalizeFinishReason(choice.finish_reason), ...(finalUsage ? { usage: finalUsage } : {}) }
        return
      }
    }
    yield* closeAll()
    yield { kind: 'finish', finishReason: 'stop' }
  } catch (err) {
    if (req.signal?.aborted) return
    yield { kind: 'finish', finishReason: 'error', error: { code: 'network', message: `openai: stream error: ${String(err)}` } }
  }
}
