/**
 * anthropic provider 单测（P4 WS-3）—— messages API wire → StreamChunk 翻译。
 *
 * 覆盖：具名事件流（message_start/content_block_start/delta/stop/message_delta/message_stop）、
 * usage disjoint 归一（input_tokens@message_start + output_tokens@message_delta 累计）、
 * stop_reason → finishReason、tool_use 块（partial_json 分片）、ping 忽略、错误码化、取消。
 */
import { describe, expect, it } from 'vitest'
import { mergeUsage, streamCompletions, DEFAULT_MODEL_NAME, DEFAULT_BASE_URL } from '../src/provider'

/** 伪 anthropic SSE：具名事件（event: xxx + data: {...}） */
function sseBody(events: { type: string; [k: string]: unknown }[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const payload =
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('') + 'data: [DONE]\n\n'
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

/** 完整一次文本回答的 anthropic 事件流 */
const TEXT_STREAM = [
  { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } },
  { type: 'message_stop' },
]

describe('mergeUsage · disjoint 记账归一', () => {
  it('input/output 两路 → promptTokens/completionTokens', () => {
    expect(mergeUsage(25, 15)).toEqual({ promptTokens: 25, completionTokens: 15 })
  })
  it('全 0 / undefined → undefined（不产 0-token 噪音）', () => {
    expect(mergeUsage(0, 0)).toBeUndefined()
    expect(mergeUsage(undefined, undefined)).toBeUndefined()
  })
  it('只到 input（output 未回）→ 仍出 usage', () => {
    expect(mergeUsage(30, 0)).toEqual({ promptTokens: 30, completionTokens: 0 })
  })
})

describe('streamCompletions · messages API 翻译', () => {
  it('具名事件流 → block/delta/finish + usage disjoint 归一 + stop_reason 归一', async () => {
    const restore = withFetch(async () => new Response(sseBody(TEXT_STREAM), { status: 200 }))
    const chunks = await drain(streamCompletions({ requestId: 'r1', messages: [{ role: 'user', content: 'hi' }], apiKey: 'k' }))
    restore()

    expect(chunks).toEqual([
      { kind: 'block-start', id: expect.stringContaining('r1'), blockType: 'text', index: 0 },
      { kind: 'delta', id: expect.stringContaining('r1'), blockType: 'text', text: '你' },
      { kind: 'delta', id: expect.stringContaining('r1'), blockType: 'text', text: '好' },
      { kind: 'block-end', id: expect.stringContaining('r1'), blockType: 'text' },
      // end_turn → 中立 finishReason（normalizeFinishReason 未知值归 stop）
      { kind: 'finish', finishReason: 'stop', usage: { promptTokens: 25, completionTokens: 15 } },
    ])
  })

  it('tool_use 块：start 带 name + partial_json 分片累积（agent 工具调用形状）', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'get_weather' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"loc' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ation":"SF"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
          { type: 'message_stop' },
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'r2', messages: [{ role: 'user', content: 'weather?' }], apiKey: 'k' }))
    restore()

    const blockStart = chunks[0]
    expect(blockStart).toMatchObject({ kind: 'block-start', blockType: 'tool_call' })
    // 工具名随 start 下发
    expect(chunks[1]).toMatchObject({ kind: 'tool-arg-delta', blockType: 'tool_call', name: 'get_weather' })
    // partial_json 分片累积到合法 JSON
    const argChunks = chunks.filter((c) => c.kind === 'tool-arg-delta' && c.name === null)
    expect(JSON.parse(argChunks.map((c) => c.arguments).join(''))).toEqual({ location: 'SF' })
    // anthropic 的 tool_use → 中立 tool_calls（agent 循环信号；不直接透传 wire 值）
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'tool_calls' })
  })

  it('ping 事件被忽略，不产生块', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          { type: 'ping' },
          ...TEXT_STREAM,
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'r3', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks.filter((c) => c.kind === 'block-start')).toHaveLength(1) // 只有文本块
  })

  it('鉴权 header：x-api-key + anthropic-version', async () => {
    let seenHeaders: Record<string, string> = {}
    let seenUrl = ''
    const restore = withFetch(async (input: any, init?: any) => {
      seenHeaders = init?.headers ?? {}
      seenUrl = typeof input === 'string' ? input : String(input)
      return new Response(sseBody(TEXT_STREAM), { status: 200 })
    })
    await drain(streamCompletions({ requestId: 'r4', messages: [], apiKey: 'sk-ant-secret' }))
    restore()
    expect(seenHeaders['x-api-key']).toBe('sk-ant-secret')
    expect(seenHeaders['anthropic-version']).toBeTruthy()
    expect(seenUrl).toBe(`${DEFAULT_BASE_URL}/v1/messages`)
  })

  it('system 消息提到顶层 system 字段，不混进 messages', async () => {
    let body: any = null
    const restore = withFetch(async (_input: any, init?: any) => {
      body = JSON.parse(init?.body as string)
      return new Response(sseBody(TEXT_STREAM), { status: 200 })
    })
    await drain(
      streamCompletions({
        requestId: 'r5',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'hi' },
        ],
        apiKey: 'k',
      }),
    )
    restore()
    expect(body.system).toBe('你是助手')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('HTTP 401 → finish{unauthorized}；429 → rate_limited', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [429, 'rate_limited']] as const) {
      const restore = withFetch(async () => new Response('err', { status }))
      const chunks = await drain(streamCompletions({ requestId: 'r6', messages: [], apiKey: 'bad' }))
      restore()
      expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code } })
    }
  })

  it('fetch 抛错 → finish{network}', async () => {
    const restore = withFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const chunks = await drain(streamCompletions({ requestId: 'r7', messages: [], apiKey: 'k' }))
    restore()
    expect(chunks[0]).toMatchObject({ kind: 'finish', finishReason: 'error', error: { code: 'network' } })
  })

  it('常量：默认模型 / baseURL', () => {
    expect(DEFAULT_MODEL_NAME).toBeTruthy()
    expect(DEFAULT_BASE_URL).toBe('https://api.anthropic.com')
  })
})

describe('mapStopReason · anthropic stop_reason → 中立', () => {
  it('max_tokens → length；tool_use → tool_calls；end_turn/stop_sequence → stop', async () => {
    const { mapStopReason } = await import('../src/provider')
    expect(mapStopReason('max_tokens')).toBe('length')
    expect(mapStopReason('tool_use')).toBe('tool_calls')
    expect(mapStopReason('end_turn')).toBe('stop')
    expect(mapStopReason('stop_sequence')).toBe('stop')
    expect(mapStopReason(undefined)).toBe('stop')
    expect(mapStopReason(null)).toBe('stop')
  })
})
