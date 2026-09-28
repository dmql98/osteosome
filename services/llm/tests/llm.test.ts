/**
 * LLM 服务单测 —— chunk / registry / resolver / stream / openrouter 适配器 / 事件装配。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { StreamChunk } from '../src/chunk'
import { isFinishBlock, validateFinishBlock } from '../src/chunk'
import { register, resolve, list, clearRegistry } from '../src/adapter/registry'
import type { LlmAdapter } from '../src/adapter/types'
import { resolveApiKey } from '../src/credentials/resolver'
import { readSseJson } from '../src/stream'
import { OPENROUTER_RETRY_POLICY, openrouterAdapter } from '../src/adapter/openrouter'

// ── chunk ──────────────────────────────────────────────
describe('chunk', () => {
  it('finish 块构造/判别', () => {
    const finish: StreamChunk = { kind: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } }
    expect(isFinishBlock(finish)).toBe(true)
    expect(validateFinishBlock(finish)).toBe(true)
  })

  it('finish 块缺 finishReason 拒绝', () => {
    expect(validateFinishBlock({ kind: 'finish' })).toBe(false)
    expect(validateFinishBlock({ kind: 'finish', finishReason: 'bogus' })).toBe(false)
    expect(validateFinishBlock({ kind: 'delta' })).toBe(false)
  })

  it('tool-arg 原始 JSON 透传不变形', () => {
    const chunk: StreamChunk = {
      kind: 'tool-arg-delta',
      id: 'tc-1',
      blockType: 'tool_call',
      name: null,
      arguments: '{"a":1,"b":[1,2]}',
    }
    expect(chunk).toMatchObject({
      kind: 'tool-arg-delta',
      arguments: '{"a":1,"b":[1,2]}',
    })
  })
})

// ── registry ───────────────────────────────────────────
const fakeAdapter = (provider: string, defaultModel: string): LlmAdapter => ({
  provider,
  defaultModel,
  async *stream() {
    /* noop */
  },
})

describe('registry', () => {
  beforeEach(() => clearRegistry())
  afterEach(() => clearRegistry())

  it('注册唯一性：重复注册抛错', () => {
    register(fakeAdapter('openrouter', 'm1'))
    expect(() => register(fakeAdapter('openrouter', 'm2'))).toThrow(/already registered/)
  })

  it('resolve 命中 / 缺失抛错', () => {
    register(fakeAdapter('openrouter', 'm1'))
    expect(resolve('openrouter').defaultModel).toBe('m1')
    expect(() => resolve('nope')).toThrow(/no adapter/)
  })

  it('list() 返回 provider + defaultModel', () => {
    register(fakeAdapter('openrouter', 'm1'))
    expect(list()).toEqual([{ provider: 'openrouter', defaultModel: 'm1' }])
  })
})

// ── resolver ───────────────────────────────────────────
describe('resolver', () => {
  const saved = process.env.OPENROUTER_API_KEY
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = saved
  })

  it('env: 命中', () => {
    process.env.OPENROUTER_API_KEY = 'sk-test'
    expect(resolveApiKey('env:OPENROUTER_API_KEY')).toBe('sk-test')
  })

  it('env: 缺失 → missing_credential', () => {
    delete process.env.OPENROUTER_API_KEY
    let caught: unknown = null
    try {
      resolveApiKey('env:OPENROUTER_API_KEY')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('missing_credential')
    expect((caught as { message?: string }).message).toMatch(/not set/)
  })
  it('core: kind 未接 → 明确 unimplemented 错', () => {
    expect(() => resolveApiKey('core:my-cred')).toThrow(/not implemented yet/)
  })
})

// ── stream（SSE 归一） ─────────────────────────────────
function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
      controller.close()
    },
  })
}

describe('stream', () => {
  it('CRLF / 行内多 data: / 连续空行 / 非 data 前缀', async () => {
    const events: unknown[] = []
    for await (const e of readSseJson(
      sseBody(['data: {"a":1}\r\n', '\r\n', 'data: {"b":2}\n', 'event: foo\n', 'id: 1\n', ': comment\n', 'data: [DONE]\n']),
    )) {
      events.push(e)
    }
    expect(events).toEqual([
      { data: { a: 1 }, done: false },
      { data: { b: 2 }, done: false },
      { data: '[DONE]', done: true },
    ])
  })

  it('截断行 / 非 JSON 忽略', async () => {
    const events: unknown[] = []
    for await (const e of readSseJson(sseBody(['data: not-json\n', 'data: {"ok":true}\n']))) {
      events.push(e)
    }
    expect(events).toEqual([{ data: { ok: true }, done: false }])
  })
})

// ── openrouter 适配器（伪 SSE） ────────────────────────
function mockFetch(bodyLines: string[], init: { status?: number } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    if (init.status && init.status >= 400) {
      return new Response('nope', { status: init.status })
    }
    return new Response(sseBody(bodyLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

async function collect(adapter: LlmAdapter, req: Parameters<LlmAdapter['stream']>[0]) {
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(req, { apiKey: 'sk-test', retryPolicy: OPENROUTER_RETRY_POLICY })) {
    chunks.push(c)
  }
  return chunks
}

describe('openrouter adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('多行 SSE → block-start/delta/block-end/finish（含 usage）', async () => {
    const restore = mockFetch([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n',
      'data: [DONE]\n',
    ])
    const chunks = await collect(openrouterAdapter, {
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'hi' }],
    })
    restore()
    expect(chunks).toEqual([
      { kind: 'block-start', id: expect.stringMatching(/^t-/), blockType: 'text', index: 0 },
      { kind: 'delta', id: expect.stringMatching(/^t-/), blockType: 'text', text: '你' },
      { kind: 'delta', id: expect.stringMatching(/^t-/), blockType: 'text', text: '好' },
      { kind: 'block-end', id: expect.stringMatching(/^t-/), blockType: 'text' },
      { kind: 'finish', finishReason: 'stop', usage: { promptTokens: 9, completionTokens: 2 } },
    ])
  })

  it('reasoning_content → reasoning 块（不渲染路径）', async () => {
    const restore = mockFetch([
      'data: {"choices":[{"delta":{"reasoning":"思考中"}}]}\n',
      'data: {"choices":[{"delta":{"content":"答"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    ])
    const chunks = await collect(openrouterAdapter, {
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'q' }],
    })
    restore()
    const blockTypes = chunks.map((c) => c.kind === 'delta' ? `${c.blockType}:${c.text}` : c.kind)
    expect(blockTypes).toEqual([
      'block-start',
      'reasoning:思考中',
      'block-start',
      'text:答',
      'block-end',
      'block-end',
      'finish',
    ])
  })

  it('HTTP 429 → finish{error:rate_limited}', async () => {
    const restore = mockFetch([], { status: 429 })
    const chunks = await collect(openrouterAdapter, {
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'x' }],
    })
    restore()
    expect(chunks).toEqual([
      { kind: 'finish', finishReason: 'error', error: { code: 'rate_limited', message: expect.stringContaining('429') } },
    ])
  })

  it('HTTP 401 → finish{error:unauthorized}', async () => {
    const restore = mockFetch([], { status: 401 })
    const chunks = await collect(openrouterAdapter, {
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'x' }],
    })
    restore()
    expect(chunks).toEqual([
      { kind: 'finish', finishReason: 'error', error: { code: 'unauthorized', message: expect.stringContaining('401') } },
    ])
  })

  it('[DONE] 提前结束 → finish{stop}（无 finish_reason）', async () => {
    const restore = mockFetch(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n'])
    const chunks = await collect(openrouterAdapter, {
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'x' }],
    })
    restore()
    const last = chunks[chunks.length - 1]
    expect(last).toMatchObject({ kind: 'finish', finishReason: 'stop' })
  })
})
