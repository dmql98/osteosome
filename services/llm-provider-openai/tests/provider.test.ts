/**
 * 通用 openai 兼容 provider 单测（P2 WS-6）—— 纯逻辑直测（对齐 WS-5 策略）。
 *
 * 在 WS-5 同构翻译层（伪 SSE / 错误码 / usage / reasoning 双块 / fetch 抛错）之上，
 * 追加 openai 专属：env 解析（baseURL / 默认模型 / extraHeaders）、自定义 baseURL 生效、附加 header 上送。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_NAME,
  resolveBaseURL,
  resolveDefaultModel,
  resolveExtraHeaders,
  streamCompletions,
} from '../src/provider'

/** 伪 SSE：把 wire 对象数组编码成 `data: <json>\n\n` 的 ReadableStream */
function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function withFetch(fetchImpl: typeof fetch) {
  const g = globalThis as { fetch?: typeof fetch }
  const prev = g.fetch
  g.fetch = fetchImpl
  return () => {
    if (prev) g.fetch = prev
    else delete g.fetch
  }
}

async function drain(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('env 解析（baseURL / 默认模型 / extraHeaders）', () => {
  it('缺省值：官方 openai + gpt-4o-mini + 无附加 header', () => {
    expect(resolveBaseURL({})).toBe(DEFAULT_BASE_URL)
    expect(resolveDefaultModel({})).toBe(DEFAULT_MODEL_NAME)
    expect(resolveExtraHeaders({})).toEqual({})
  })

  it('OPENAI_BASE_URL 生效且去尾部斜杠', () => {
    expect(resolveBaseURL({ OPENAI_BASE_URL: 'https://vllm.local/v1/' })).toBe('https://vllm.local/v1')
    expect(resolveBaseURL({ OPENAI_BASE_URL: '  https://ollama.local  ' })).toBe('https://ollama.local')
  })

  it('OPENAI_MODEL 生效', () => {
    expect(resolveDefaultModel({ OPENAI_MODEL: 'qwen2.5-72b' })).toBe('qwen2.5-72b')
  })

  it('OPENAI_EXTRA_HEADERS 解析合法 JSON，畸形/非对象回退空', () => {
    expect(resolveExtraHeaders({ OPENAI_EXTRA_HEADERS: '{"HTTP-Referer":"https://x.io","X-Title":"ost"}' })).toEqual({
      'HTTP-Referer': 'https://x.io',
      'X-Title': 'ost',
    })
    expect(resolveExtraHeaders({ OPENAI_EXTRA_HEADERS: 'not-json' })).toEqual({})
    expect(resolveExtraHeaders({ OPENAI_EXTRA_HEADERS: '42' })).toEqual({})
  })
})

describe('streamCompletions（openai 兼容 wire，对齐 WS-5 翻译层）', () => {
  it('delta 归一：block-start → delta → block-end → finish{stop} + usage', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
          {
            id: 'x',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks).toEqual([
      { kind: 'block-start', id: 't-r1-0', blockType: 'text', index: 0 },
      { kind: 'delta', id: 't-r1-0', blockType: 'text', text: '你' },
      { kind: 'delta', id: 't-r1-0', blockType: 'text', text: '好' },
      { kind: 'block-end', id: 't-r1-0', blockType: 'text' },
      { kind: 'finish', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } },
    ])
  })

  it('自定义 baseURL 生效：请求打到 {baseURL}/chat/completions 且带 Bearer', async () => {
    let seenURL = ''
    let seenAuth = ''
    const restore = withFetch(async (input: any, init?: any) => {
      seenURL = typeof input === 'string' ? input : String(input)
      seenAuth = init?.headers?.Authorization ?? ''
      return new Response(sseBody([{ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]), { status: 200 })
    })
    await drain(
      streamCompletions({ requestId: 'r2', messages: [], apiKey: 'sk-123', baseURL: 'https://vllm.local/v1' }),
    )
    restore()
    expect(seenURL).toBe('https://vllm.local/v1/chat/completions')
    expect(seenAuth).toBe('Bearer sk-123')
  })

  it('extraHeaders 合并上送（含默认 EXTRA_HEADERS 之上覆盖）', async () => {
    let seenHeaders: Record<string, string> = {}
    const restore = withFetch(async (_input: any, init?: any) => {
      seenHeaders = init?.headers ?? {}
      return new Response(sseBody([{ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]), { status: 200 })
    })
    await drain(
      streamCompletions({
        requestId: 'r3',
        messages: [],
        apiKey: 'k',
        extraHeaders: { 'X-Title': 'ost-custom', 'HTTP-Referer': 'https://ref.io' },
      }),
    )
    restore()
    expect(seenHeaders['X-Title']).toBe('ost-custom')
    expect(seenHeaders['HTTP-Referer']).toBe('https://ref.io')
  })

  it('HTTP 401 → finish{unauthorized}；429 → rate_limited；503 → server_error', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [429, 'rate_limited'],
      [503, 'server_error'],
    ] as const) {
      const restore = withFetch(async () => new Response('err', { status }))
      const chunks = await drain(streamCompletions({ requestId: 'r4', messages: [], apiKey: 'k' }))
      restore()
      expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code } })
    }
  })

  it('reasoning + content 双块（思考链端点）', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          { id: 'x', choices: [{ index: 0, delta: { reasoning: '先想' }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: { content: '答' }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'r5', messages: [], apiKey: 'k' }))
    restore()
    const kinds = chunks.map((c) => c.kind)
    expect(kinds).toEqual(['block-start', 'delta', 'block-start', 'delta', 'block-end', 'block-end', 'finish'])
    const textDeltas = chunks.filter((c) => c.kind === 'delta' && c.blockType === 'text').map((c) => c.text)
    const reasoningDeltas = chunks.filter((c) => c.kind === 'delta' && c.blockType === 'reasoning').map((c) => c.text)
    expect(textDeltas).toEqual(['答'])
    expect(reasoningDeltas).toEqual(['先想'])
  })

  it('fetch 抛错 → finish{network}；wire error 对象 → finish{invalid_request}', async () => {
    const restore = withFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const chunks = await drain(streamCompletions({ requestId: 'r6', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'network' } })

    const restore2 = withFetch(async () => new Response(sseBody([{ error: { message: 'model not found' } }]), { status: 200 }))
    const chunks2 = await drain(streamCompletions({ requestId: 'r7', messages: [], apiKey: 'k' }))
    restore2()
    expect(chunks2[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'invalid_request' } })
  })

  it('模块常量在默认 env 下可读（DEFAULT_MODEL / BASE_URL 等）', () => {
    // 常量在模块加载时解析，这里直接引用 provider 导出的解析函数验证等价行为
    expect(resolveDefaultModel({})).toBe(DEFAULT_MODEL_NAME)
    expect(resolveBaseURL({})).toBe(DEFAULT_BASE_URL)
  })
})
