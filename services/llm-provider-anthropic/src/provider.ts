/**
 * llm-provider-anthropic —— anthropic messages API provider 纯逻辑（P4 WS-3）。
 *
 * 与 openai 兼容系（deepseek/openrouter/openai）**wire 形状完全不同**——这是本包存在的意义：
 *
 * | 维度 | openai 兼容 | anthropic messages |
 * |---|---|---|
 * | 端点 | `/chat/completions` | `/messages` |
 * | 鉴权 | `Authorization: Bearer` | `x-api-key` + `anthropic-version` |
 * | 流事件 | 只有 `data:`，内容在 `choices[0].delta` | **具名事件**（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` / `ping`） |
 * | 文本 | `delta.content` | `content_block_delta.delta.text`（分块） |
 * | 工具 | `delta.tool_calls[]` | `content_block_start.content_block.type='tool_use'` + `delta.partial_json` |
 * | usage | 单个 `usage` 对象 | **跨事件**：input_tokens 在 `message_start`，output_tokens 在 `message_delta`（**累计值**） |
 * | 结束 | `finish_reason` | `message_delta.delta.stop_reason` |
 *
 * **disjoint 记账归一**（P4 §WS-3 硬要求）：把 input/output 两路累计值归一为
 * `Usage.promptTokens` / `Usage.completionTokens`（P2 只填总量）。
 */
import {
  readSseJson,
  type FinishReason,
  type StreamChunk,
  type StreamError,
  type RetryPolicy,
  type Usage,
} from '@osteosome/shared'

export const PROVIDER = 'anthropic'
export const CREDENTIAL_REF = 'env:ANTHROPIC_API_KEY'

export const DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const DEFAULT_MODEL_NAME = 'claude-sonnet-4-5'
export const ANTHROPIC_VERSION = '2023-06-01'

/** env 解析：baseURL（去尾部 `/`） */
export function resolveBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.ANTHROPIC_BASE_URL?.trim()
  return v && v.length > 0 ? v.replace(/\/+$/, '') : DEFAULT_BASE_URL
}

/** env 解析：默认模型 */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.ANTHROPIC_MODEL?.trim()
  return v && v.length > 0 ? v : DEFAULT_MODEL_NAME
}

export const DEFAULT_MODEL = resolveDefaultModel()
export const BASE_URL = resolveBaseURL()

/** 模型目录静态兜底（P4 WS-3） */
export const STATIC_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']

/** P2 声明（与 openai 系同构）；P4 可被 config.json 覆盖 */
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
  signal?: AbortSignal
  apiKey: string
  /** 覆盖默认 baseURL（测试 / 运行期自定义） */
  baseURL?: string
}

interface AnthropicBlockStart {
  type?: string
  content_block?: { type?: string; name?: string }
}
interface AnthropicDelta {
  type?: string
  text?: string
  stop_reason?: string | null
}
interface WireEvent {
  type?: string
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  index?: number
  content_block?: { type?: string; name?: string }
  delta?: AnthropicDelta & { partial_json?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
}

function mapHttpError(status: number, bodyText: string): StreamError {
  switch (status) {
    case 401:
    case 403:
      return { code: 'unauthorized', message: `anthropic: HTTP ${status}` }
    case 429:
      return { code: 'rate_limited', message: 'anthropic: HTTP 429' }
    default:
      if (status >= 500) return { code: 'server_error', message: `anthropic: HTTP ${status}` }
      return {
        code: 'invalid_request',
        message: `anthropic: HTTP ${status} ${bodyText.slice(0, 200)}`,
      }
  }
}

/**
 * 归一 anthropic 的 `stop_reason` → 中立 FinishReason。
 *
 * **不能用 shared 的 `normalizeFinishReason`**——那是 openai 词汇表（`tool_calls`），
 * anthropic 说 `tool_use` / `max_tokens`，直接落进去会全被归成 `stop`（P4 WS-3 单测实证）。
 *
 * | anthropic | 中立 |
 * |---|---|
 * | `end_turn` / `stop_sequence` | `stop` |
 * | `max_tokens` | `length` |
 * | `tool_use` | `tool_calls` |
 * | 其他/缺省 | `stop` |
 */
export function mapStopReason(reason: string | undefined | null): FinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop'
  }
}

/**
 * 归一 anthropic 分散的 usage 字段 → 中立 Usage（disjoint 记账）。
 * - input_tokens 来自 message_start（一次性）
 * - output_tokens 来自 message_delta（**累计值**，取最后一条即可）
 */
export function mergeUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): Usage | undefined {
  const promptTokens = typeof inputTokens === 'number' ? inputTokens : 0
  const completionTokens = typeof outputTokens === 'number' ? outputTokens : 0
  if (promptTokens === 0 && completionTokens === 0) return undefined
  return { promptTokens, completionTokens }
}

/**
 * 消费 anthropic messages SSE → yield StreamChunk。
 *
 * 块映射：
 * - `content_block_start{type:'text'}` → block-start(text)
 * - `content_block_delta{text}` → delta(text)
 * - `content_block_start{type:'tool_use'}` → block-start(tool_call) + tool-arg-delta(name)
 * - `content_block_delta{partial_json}` → tool-arg-delta(name=null, arguments 片段)
 * - `content_block_stop` → block-end
 * - `message_delta{stop_reason}` → finish（usage 归一）
 * - `ping` / 未知事件 → 忽略
 */
export async function* streamCompletions(req: StreamRequest): AsyncGenerator<StreamChunk, void, void> {
  const base = req.baseURL ?? BASE_URL
  const url = `${base}/v1/messages`
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const turns = req.messages.filter((m) => m.role !== 'system')

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model ?? DEFAULT_MODEL,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: turns.map((m) => ({ role: m.role, content: m.content })),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: true,
      }),
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal?.aborted) return
    yield { kind: 'finish', finishReason: 'error', error: { code: 'network', message: `anthropic: fetch failed: ${String(err)}` } }
    return
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    yield { kind: 'finish', finishReason: 'error', error: mapHttpError(res.status, bodyText) }
    return
  }

  // 块 id 追踪：index（anthropic）→ 块 id
  const blockIds = new Map<number, string>()
  let seq = 0
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let stopReason: string | undefined

  try {
    for await (const event of readSseJson(res.body, { signal: req.signal })) {
      if (event.done) break
      const data = event.data as WireEvent
      if (!data || typeof data !== 'object') continue

      switch (data.type) {
        case 'message_start': {
          inputTokens = data.message?.usage?.input_tokens
          break
        }
        case 'content_block_start': {
          const index = typeof data.index === 'number' ? data.index : 0
          const blockType = data.content_block?.type
          const id = `b-${req.requestId}-${index}-${seq++}`
          blockIds.set(index, id)
          if (blockType === 'tool_use') {
            yield { kind: 'block-start', id, blockType: 'tool_call', index: seq - 1 }
            // 工具名随 start 事件下发（wire 用 content_block.name）
            const name = data.content_block?.name
            if (typeof name === 'string' && name.length > 0) {
              yield { kind: 'tool-arg-delta', id, blockType: 'tool_call', name, arguments: '' }
            }
          } else {
            yield { kind: 'block-start', id, blockType: 'text', index: seq - 1 }
          }
          break
        }
        case 'content_block_delta': {
          const index = typeof data.index === 'number' ? data.index : 0
          const id = blockIds.get(index)
          if (id === undefined) break
          const delta = data.delta ?? {}
          if (typeof delta.text === 'string' && delta.text.length > 0) {
            yield { kind: 'delta', id, blockType: 'text', text: delta.text }
          } else if (typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
            // wire 工具参数分片（partial_json 原样透传，调用方拼装）
            yield {
              kind: 'tool-arg-delta',
              id,
              blockType: 'tool_call',
              name: null,
              arguments: delta.partial_json,
            }
          }
          break
        }
        case 'content_block_stop': {
          const index = typeof data.index === 'number' ? data.index : 0
          const id = blockIds.get(index)
          if (id !== undefined) yield { kind: 'block-end', id, blockType: 'text' }
          blockIds.delete(index) // 已闭合 → message_stop 不再重复收尾
          break
        }
        case 'message_delta': {
          outputTokens = data.usage?.output_tokens ?? outputTokens
          if (typeof data.delta?.stop_reason === 'string') stopReason = data.delta.stop_reason
          break
        }
        case 'message_stop': {
          // 收尾：关所有未闭合块 + finish（usage disjoint 归一）
          for (const id of blockIds.values()) yield { kind: 'block-end', id, blockType: 'text' }
          blockIds.clear()
          const usage = mergeUsage(inputTokens, outputTokens)
          yield {
            kind: 'finish',
            finishReason: mapStopReason(stopReason),
            ...(usage ? { usage } : {}),
          }
          return
        }
        default:
          // ping / 未知事件 → 忽略
          break
      }
    }
    // 流自然结束（未见 message_stop）
    for (const id of blockIds.values()) yield { kind: 'block-end', id, blockType: 'text' }
    const usage = mergeUsage(inputTokens, outputTokens)
    yield {
      kind: 'finish',
      finishReason: mapStopReason(stopReason),
      ...(usage ? { usage } : {}),
    }
  } catch (err) {
    if (req.signal?.aborted) return
    yield { kind: 'finish', finishReason: 'error', error: { code: 'network', message: `anthropic: stream error: ${String(err)}` } }
  }
}
