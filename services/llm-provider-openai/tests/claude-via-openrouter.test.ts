/**
 * claude 经 OpenRouter 的对照回归（取代被删的 anthropic provider 单测）
 *
 * 背景：架构决定不接 Anthropic 原生 wire（messages API 的具名事件流 + x-api-key +
 * stop_reason/tool_use 私有枚举）。claude 改由「通用 openai 兼容 provider + openrouter
 * 预设」调用 —— 网关把它翻译成 openai 形状后，下游翻译层一行都不用改。
 *
 * 那这份文件守什么？守「换厂商只换模型名」这个承诺：
 *   1. 厂商表里确实登记了能调 claude 的入口，且 anthropic 不是独立预设（决定写进数据，不只写在注释里）
 *   2. claude 的回答经通用路径出来，仍是标准中立块（block-start/delta/block-end/finish）
 *   3. claude 的工具调用仍是 P7 agent 循环要的 tool_calls 信号（否则 claude 就当不了 agent 后端）
 *   4. claude 的思考链（网关把 thinking 映射成 reasoning 字段）没丢
 *   5. 网关已归一 stop reason，通用层再归一一次仍是中立枚举
 *
 * 不重复 provider.test.ts 已覆盖的错误码（401/429/503/network/wire error）与 delta 归一基线。
 */
import { describe, expect, it } from 'vitest'
import { VENDOR_PRESETS, findVendorPreset, hasVendorCredential } from '@osteosome/shared'
import { streamCompletions } from '../src/provider'

/** 伪 openai 形状 SSE（OpenRouter 转译后的 claude 响应即此形状） */
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

function withFetch(fetchImpl: typeof fetch): () => void {
  const g = globalThis as { fetch?: typeof fetch }
  const prev = g.fetch
  g.fetch = fetchImpl
  return () => {
    if (prev) g.fetch = prev
    else delete g.fetch
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = []
  for await (const c of gen) out.push(c)
  return out
}

const CLAUDE = 'anthropic/claude-3.5-sonnet'
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

describe('厂商表 · claude 的调用入口', () => {
  it('openrouter 预设收录 claude 模型（默认模型不必是 claude）', () => {
    const or = findVendorPreset('openrouter')
    expect(or).toBeDefined()
    expect(or!.models).toContain(CLAUDE)
    expect(or!.defaultModel).not.toContain('claude')
  })

  it('anthropic 不是独立预设：原生 wire 不接，claude 只经网关调', () => {
    expect(findVendorPreset('anthropic')).toBeUndefined()
    expect(VENDOR_PRESETS.map((v) => v.id)).not.toContain('anthropic')
  })

  it('全部预设的 api 均为 openai 形状（无原生 wire 分支需维护）', () => {
    expect([...new Set(VENDOR_PRESETS.map((v) => v.api))]).toEqual(['openai'])
  })

  it('配了 OPENROUTER_API_KEY 才注册 openrouter 实例', () => {
    expect(hasVendorCredential(findVendorPreset('openrouter')!, {})).toBe(false)
    expect(hasVendorCredential(findVendorPreset('openrouter')!, { OPENROUTER_API_KEY: 'k' })).toBe(true)
  })
})

describe('streamCompletions · claude 走通用路径', () => {
  it('文本回答 → 标准中立块 + usage（模型名不改变翻译层行为）', async () => {
    const restore = withFetch(
      async () =>
        new Response(
          sseBody([
            { model: CLAUDE, choices: [{ index: 0, delta: { content: '你' } }] },
            { model: CLAUDE, choices: [{ index: 0, delta: { content: '好' } }] },
            {
              model: CLAUDE,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 25, completion_tokens: 15 },
            },
          ]),
          { status: 200 },
        ),
    )
    const chunks = await drain(
      streamCompletions({
        requestId: 'claude-1',
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        model: CLAUDE,
        baseURL: OPENROUTER_BASE,
      }),
    )
    restore()

    expect(chunks).toEqual([
      { kind: 'block-start', id: expect.stringContaining('claude-1'), blockType: 'text', index: 0 },
      { kind: 'delta', id: expect.stringContaining('claude-1'), blockType: 'text', text: '你' },
      { kind: 'delta', id: expect.stringContaining('claude-1'), blockType: 'text', text: '好' },
      { kind: 'block-end', id: expect.stringContaining('claude-1'), blockType: 'text' },
      { kind: 'finish', finishReason: 'stop', usage: { promptTokens: 25, completionTokens: 15 } },
    ])
  })

  it('工具调用 → finish{tool_calls}：claude 仍能当 P7 agent 后端', async () => {
    const restore = withFetch(
      async () =>
        new Response(
          sseBody([
            {
              model: CLAUDE,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
                    ],
                  },
                },
              ],
            },
            {
              model: CLAUDE,
              choices: [
                { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] } },
              ],
            },
            {
              model: CLAUDE,
              choices: [
                { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }, finish_reason: 'tool_calls' },
              ],
            },
          ]),
          { status: 200 },
        ),
    )
    const chunks = await drain(
      streamCompletions({
        requestId: 'claude-2',
        messages: [{ role: 'user', content: 'weather?' }],
        apiKey: 'k',
        model: CLAUDE,
        baseURL: OPENROUTER_BASE,
        tools: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object' } }],
      }),
    )
    restore()

    // 块序列与 openai 直连完全一致：block-start → tool-arg-delta(带 name) → args 分片 → finish
    expect(chunks[0]).toMatchObject({ kind: 'block-start', blockType: 'tool_call' })
    // 工具名随第一帧 tool-arg-delta 下发（wire 首帧 arguments 为空）
    expect(chunks[1]).toMatchObject({ kind: 'tool-arg-delta', blockType: 'tool_call', name: 'get_weather' })
    // 分片 arguments 累积成合法 JSON（网关已把 tool_use 摊平成 tool_calls，这里验的是通用累积逻辑）
    const args = chunks
      .filter((c) => c.kind === 'tool-arg-delta')
      .map((c) => c.arguments)
      .join('')
    expect(JSON.parse(args)).toEqual({ location: 'SF' })
    // P7 agent 循环的唯一信号
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'tool_calls' })
  })

  it('思考链没丢：网关的 reasoning 字段 → reasoning 块', async () => {
    const restore = withFetch(
      async () =>
        new Response(
          sseBody([
            { model: CLAUDE, choices: [{ index: 0, delta: { reasoning: '先想…' } }] },
            { model: CLAUDE, choices: [{ index: 0, delta: { content: '答' } }] },
            { model: CLAUDE, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]),
          { status: 200 },
        ),
    )
    const chunks = await drain(
      streamCompletions({ requestId: 'claude-3', messages: [], apiKey: 'k', model: CLAUDE, baseURL: OPENROUTER_BASE }),
    )
    restore()

    expect(chunks.filter((c) => c.kind === 'block-start').map((c) => c.blockType)).toEqual(['reasoning', 'text'])
    expect(chunks[1]).toMatchObject({ kind: 'delta', blockType: 'reasoning', text: '先想…' })
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'stop' })
  })

  it('网关已归一的 stop reason 再过通用层仍是中立枚举', async () => {
    for (const [wire, neutral] of [
      ['stop', 'stop'],
      ['tool_calls', 'tool_calls'],
      ['length', 'length'],
    ] as const) {
      const restore = withFetch(
        async () =>
          new Response(sseBody([{ model: CLAUDE, choices: [{ index: 0, delta: {}, finish_reason: wire }] }]), {
            status: 200,
          }),
      )
      const chunks = await drain(
        streamCompletions({ requestId: 'claude-4', messages: [], apiKey: 'k', model: CLAUDE, baseURL: OPENROUTER_BASE }),
      )
      restore()
      expect(chunks.at(-1), `wire ${wire}`).toMatchObject({ kind: 'finish', finishReason: neutral })
    }
  })

  it('请求打到 openrouter 的 chat/completions，带网关惯例的 HTTP-Referer/X-Title 可选头', async () => {
    let seenUrl = ''
    let seenBody: any = null
    const restore = withFetch(async (input: any, init?: any) => {
      seenUrl = typeof input === 'string' ? input : String(input)
      seenBody = JSON.parse(init?.body as string)
      return new Response(sseBody([{ model: CLAUDE, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]), {
        status: 200,
      })
    })
    await drain(
      streamCompletions({
        requestId: 'claude-5',
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        model: CLAUDE,
        baseURL: OPENROUTER_BASE,
        extraHeaders: { 'HTTP-Referer': 'https://osteosome.local', 'X-Title': 'Osteosome' },
      }),
    )
    restore()

    expect(seenUrl).toBe(`${OPENROUTER_BASE}/chat/completions`)
    expect(seenBody.model).toBe(CLAUDE)
    expect(seenBody.stream).toBe(true)
  })
})
