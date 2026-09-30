/**
 * tool_calls 协议贯通验证（P2 收尾 · agent 可行性实证）。
 *
 * 回答一个具体问题：**P2 的中立流协议（StreamChunk）能不能撑起最小对话 agent？**
 * 用 openai 兼容 wire 的真实 tool_calls 流式形状驱动 provider，断言：
 * 1. wire `delta.tool_calls[]` 分片 → `block-start(tool_call)` + `tool-arg-delta` 块；
 * 2. 同一 tool_call 的 arguments 分多帧累积到**同一块 id**（wire index 映射）；
 * 3. `finish_reason: 'tool_calls'` 归一为 `finishReason: 'tool_calls'`（agent 循环的分支信号）；
 * 4. 全部未闭合块在 finish 前被 block-end 收尾。
 *
 * 若这些断言成立，P7 只需在主位/loop 层接上「执行工具 → 回填 role:tool → 再发一轮」，
 * 无需重写 provider 协议——即协议层不欠 agent 的债。
 */
import { describe, expect, it } from 'vitest'
import { streamCompletions } from '../src/provider'

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

/** openai 兼容 tool_calls 真实形状：首帧带 name，后续帧只带 arguments 分片 */
const TOOL_CALL_STREAM = [
  {
    id: 'chatcmpl-1',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-1',
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null },
    ],
  },
  {
    id: 'chatcmpl-1',
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"SF"}' } }] }, finish_reason: null },
    ],
  },
  {
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  },
]

describe('tool_calls 贯通（agent 可行性验证）', () => {
  it('wire tool_calls 分片 → tool_call 块 + arguments 累积到同一 id + finishReason tool_calls', async () => {
    const restore = withFetch(async () => new Response(sseBody(TOOL_CALL_STREAM), { status: 200 }))
    const chunks = await drain(streamCompletions({ requestId: 'a1', messages: [], apiKey: 'k' }))
    restore()

    // 1) 块序列：block-start → tool-arg-delta ×3（name 帧 + 2 个 args 帧）→ block-end → finish
    expect(chunks.map((c) => c.kind)).toEqual([
      'block-start',
      'tool-arg-delta',
      'tool-arg-delta',
      'tool-arg-delta',
      'block-end',
      'finish',
    ])

    // 2) 首帧携带工具名（wire 该帧 arguments 为空串 —— 名字必须活下来）
    const start = chunks[0]
    expect(start).toMatchObject({ kind: 'block-start', blockType: 'tool_call' })
    const first = chunks[1]
    expect(first).toMatchObject({ kind: 'tool-arg-delta', blockType: 'tool_call', name: 'get_weather' })

    // 3) 后续帧同块累积 arguments（wire index 0 → 同一 id），name 为 null
    const blockId = start.id
    expect(chunks[2].id).toBe(blockId)
    expect(chunks[2].name).toBeNull()

    // 4) 拼装出的 arguments 是完整 JSON 片段（调用方自行拼，协议不解析不丢失）
    const args = chunks
      .filter((c) => c.kind === 'tool-arg-delta')
      .map((c) => c.arguments)
      .join('')
    expect(args).toBe('{"location":"SF"}')
    expect(JSON.parse(args)).toEqual({ location: 'SF' })

    // 5) finish 前 block-end 收尾 + finishReason 归一为 tool_calls（agent 循环的分支信号）
    expect(chunks[4]).toMatchObject({ kind: 'block-end', blockType: 'tool_call', id: blockId })
    expect(chunks[5]).toMatchObject({
      kind: 'finish',
      finishReason: 'tool_calls',
      usage: { promptTokens: 20, completionTokens: 8 },
    })
  })

  it('并行多个 tool_call：各自独立块 id，互不串流', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '{}' } },
                    { index: 1, id: 'call_b', function: { name: 'get_time', arguments: '{}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'a2', messages: [], apiKey: 'k' }))
    restore()

    const starts = chunks.filter((c) => c.kind === 'block-start')
    expect(starts).toHaveLength(2)
    expect(starts[0].id).not.toBe(starts[1].id)
    // 两个 block-end 对应两个块
    expect(chunks.filter((c) => c.kind === 'block-end')).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'tool_calls' })
  })

  it('文本 + 工具调用混合：两类块共存，finish 收尾全部', async () => {
    const restore = withFetch(async () =>
      new Response(
        sseBody([
          { choices: [{ index: 0, delta: { content: '我查一下' }, finish_reason: null }] },
          {
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '{"c":"SF"}' } }] }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { status: 200 },
      ),
    )
    const chunks = await drain(streamCompletions({ requestId: 'a3', messages: [], apiKey: 'k' }))
    restore()

    expect(chunks.some((c) => c.blockType === 'text')).toBe(true)
    expect(chunks.some((c) => c.blockType === 'tool_call')).toBe(true)
    const ends = chunks.filter((c) => c.kind === 'block-end').map((c) => c.blockType)
    expect(ends).toEqual(expect.arrayContaining(['text', 'tool_call']))
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'tool_calls' })
  })

  it('带 tools 定义时上送 tools（模型才可能发起 tool_calls）', async () => {
    let seenBody: any = null
    const restore = withFetch(async (_input: any, init?: any) => {
      seenBody = JSON.parse(init?.body as string)
      return new Response(sseBody([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]), { status: 200 })
    })
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }]
    await drain(streamCompletions({ requestId: 'a4', messages: [], apiKey: 'k', tools }))
    restore()
    expect(seenBody.tools).toEqual(tools)
    expect(seenBody.stream).toBe(true)
  })

  it('不传 tools 时请求体不含 tools 字段（普通对话不污染 wire）', async () => {
    let seenBody: any = null
    const restore = withFetch(async (_input: any, init?: any) => {
      seenBody = JSON.parse(init?.body as string)
      return new Response(sseBody([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]), { status: 200 })
    })
    await drain(streamCompletions({ requestId: 'a5', messages: [], apiKey: 'k' }))
    restore()
    expect('tools' in seenBody).toBe(false)
  })
})
