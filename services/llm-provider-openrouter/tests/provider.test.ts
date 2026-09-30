/**
 * LLM provider 能力位单测（P2 WS-5）—— 纯逻辑直测（对齐 WS-3/WS-4 策略：不追 vitest ESM 帧往返怪癖）。
 *
 * 测 provider.ts：伪 SSE wire → StreamChunk 翻译 / 错误码 / usage 归一。
 * 凭证缺失（missing_credential）与取消（finish{stop}）是装配层行为，由 index.ts 逻辑审阅 + WS-9 集成冒烟覆盖。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, RETRY_POLICY, streamCompletions } from '../src/provider'

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

const ok = new Response(sseBody([]), { status: 200 })

function withFetch(fetchImpl: typeof fetch) {
  const g = globalThis as { fetch?: typeof fetch }
  const prev = g.fetch
  g.fetch = fetchImpl
  return () => {
    if (prev) g.fetch = prev
    else delete g.fetch
  }
}

/** 收集 generator 全部块 */
async function drain(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('streamCompletions (shared openai wire)', () => {
  it('delta 归一：block-start → delta → block-end → finish{stop}', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          {
            id: 'x',
            choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }],
          },
          {
            id: 'x',
            choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }],
          },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
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

  it('HTTP 401 → finish{unauthorized}', async () => {
    const restore = withFetch(async () => new Response('no key', { status: 401 }))
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'bad' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'unauthorized' } })
    expect(String(chunks[0].error.message)).toContain('HTTP 401')
  })

  it('HTTP 429 → finish{rate_limited}', async () => {
    const restore = withFetch(async () => new Response('slow down', { status: 429 }))
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'rate_limited' } })
  })

  it('5xx → finish{server_error}', async () => {
    const restore = withFetch(async () => new Response('boom', { status: 503 }))
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'server_error' } })
  })

  it('wire error 对象 → finish{invalid_request}', async () => {
    const restore = withFetch(async () => new Response(sseBody([{ error: { message: 'model not found' } }]), { status: 200 }))
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'invalid_request' } })
  })

  it('reasoning + content 双块（openrouter 思考链）', async () => {
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
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    const kinds = chunks.map((c) => c.kind)
    expect(kinds).toEqual(['block-start', 'delta', 'block-start', 'delta', 'block-end', 'block-end', 'finish'])
    const textDeltas = chunks.filter((c) => c.kind === 'delta' && c.blockType === 'text').map((c) => c.text)
    const reasoningDeltas = chunks
      .filter((c) => c.kind === 'delta' && c.blockType === 'reasoning')
      .map((c) => c.text)
    expect(textDeltas).toEqual(['答'])
    expect(reasoningDeltas).toEqual(['先想'])
  })

  it('finishReason 非标准值归一为 error 外的合法值 / 空流 → finish{stop}', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          { id: 'x', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'length' }] },
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'length' })
  })

  it('异常安全：fetch 抛错 → finish{network}', async () => {
    const restore = withFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'network' } })
  })
})

describe('provider 常量', () => {
  it('模型/retry 常量可读', () => {
    expect(DEFAULT_MODEL.length).toBeGreaterThan(0)
    expect(RETRY_POLICY.maxAttempts).toBe(3)
  })
})
