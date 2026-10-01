/**
 * P4 集成冒烟（WS-5）—— 真 Core + 全部 9 服务，验证 P4 三块新增能力。
 *
 * 在 P3（四服务会话编排）基础上，本文件聚焦 P4 独有的链路：
 *  1) 模型目录：`llm.models.list` → provider 拉上游 /models → `llm.models.list.result`
 *     （remote：上游有 data；static：上游 404/失败 → 静态兜底）
 *  2) anthropic provider（第一个非 openai 兼容 wire）：/v1/messages 具名事件 → StreamChunk
 *  3) 错误码化：401 → unauthorized（非瞬态，retry 立即失败不重试）；
 *     429 → rate_limited（瞬态，llm-retry 执行器按退避重发 → 重试成功）
 *
 * 假上游：OPENAI_BASE_URL / ANTHROPIC_BASE_URL 均可配（WS-6 / WS-3 设计），指向本测试
 * 起的本地 HTTP server——openai 兼容 /v1/chat/completions + anthropic /v1/messages +
 * 模型目录 /models，按需注入 401/429。无需真实 API key / 外网。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type Core } from '../src/main'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface SseEvent {
  topic: string
  payload: Record<string, unknown>
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(80)
  }
}

function parseSseEvents(raw: string): SseEvent[] {
  const out: SseEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const parsed = JSON.parse(line.slice(6)) as SseEvent
      if (typeof parsed.topic === 'string' && parsed.payload && typeof parsed.payload === 'object') out.push(parsed)
    } catch {
      /* partial frame */
    }
  }
  return out
}

async function openSse(base: string, query = ''): Promise<{ text: () => string; close: () => void }> {
  const controller = new AbortController()
  const res = await fetch(`${base}/events${query}`, { signal: controller.signal })
  expect(res.status).toBe(200)
  let buf = ''
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
    } catch {
      /* aborted */
    }
  })()
  return { text: () => buf, close: () => controller.abort() }
}

async function post(base: string, topic: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, payload }),
  })
  expect(res.status).toBe(202)
  await res.text().catch(() => '')
}

/**
 * 假上游：一个 HTTP server 同时充当 openai / anthropic 两家上游。
 * - `/v1/chat/completions`：openai 兼容 SSE（`data:` 帧 + `[DONE]`）
 * - `/v1/messages`：anthropic 具名事件（message_start / content_block_start /
 *   content_block_delta / message_delta / message_stop）
 * - `/models`：模型目录（openai 与 anthropic 都指向它；默认 200 返回 data）
 *   - `state.modelsStatus`: 'ok' | 'not-found' | 'bad-json' 控制远端/静态降级
 * - 注入开关：`state.openaiStatus` / `state.anthropicStatus` 设 HTTP 状态（401/429）模拟错误
 */
interface UpstreamState {
  text: string
  models: string[]
  modelsStatus: 'ok' | 'not-found' | 'bad-json'
  openaiStatus: number
  /** 429Once：openai 首次请求 429（触发 retry），之后自动 200（验证重试成功） */
  openai429Once: boolean
  anthropicStatus: number
  openaiHits: number
  anthropicHits: number
}

function startFakeUpstream(): Promise<{ server: Server; baseUrl: string; state: UpstreamState }> {
  const state: UpstreamState = {
    text: '你好',
    models: ['gpt-4o-mini', 'gpt-4o'],
    modelsStatus: 'ok',
    openaiStatus: 200,
    openai429Once: false,
    anthropicStatus: 200,
    openaiHits: 0,
    anthropicHits: 0,
  }
  const server = createServer((req, res) => {
    const url = req.url ?? ''

    // 模型目录（两家共用；anthropic 的 BASE_URL 无 /v1 后缀，openai 带 /v1）
    if (url.endsWith('/models') || url.endsWith('/v1/models')) {
      if (state.modelsStatus === 'not-found') {
        res.writeHead(404).end()
        return
      }
      if (state.modelsStatus === 'bad-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{ not json')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ data: state.models.map((id) => ({ id, object: 'model' })) }),
      )
      return
    }

    // anthropic /v1/messages：具名事件流
    if (url.includes('/v1/messages')) {
      state.anthropicHits += 1
      if (state.anthropicStatus !== 200) {
        res.writeHead(state.anthropicStatus).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } })
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      for (const c of [...state.text]) {
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } })
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: state.text.length } })
      send('message_stop', { type: 'message_stop' })
      res.end()
      return
    }

    // openai 兼容 /v1/chat/completions
    if (url.includes('/chat/completions')) {
      state.openaiHits += 1
      if (state.openai429Once && state.openaiHits === 1) {
        res.writeHead(429).end()
        return
      }
      if (state.openaiStatus !== 200) {
        res.writeHead(state.openaiStatus).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      for (const c of [...state.text]) {
        send({ id: 'x', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })
      }
      send({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: [...state.text].length } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, state })
    })
  })
}

describe('P4 集成冒烟 · 模型目录 + anthropic + 错误码化', () => {
  let core: Core | undefined
  let dataDir = ''
  let upstream: { server: Server; baseUrl: string; state: UpstreamState } | undefined

  const envKeys = [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'LLM_PROVIDER',
  ]

  const base = (): string => `http://127.0.0.1:${core!.port}`
  const serviceIds = [
    'llm',
    'session',
    'loop',
    'credentials',
    'llm-provider-deepseek',
    'llm-provider-openrouter',
    'llm-provider-openai',
    'llm-provider-anthropic',
    'llm-retry',
  ]

  beforeAll(async () => {
    upstream = await startFakeUpstream()
    process.env.OPENAI_BASE_URL = `${upstream.baseUrl}/v1`
    process.env.ANTHROPIC_BASE_URL = upstream.baseUrl
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    process.env.LLM_PROVIDER = 'openai'

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-p4-smoke-'))
    core = await startCore({
      argv: [],
      config: {
        servicesDir: path.join(REPO_ROOT, 'services'),
        dataDir,
        distDir: path.join(dataDir, 'dist-client'),
        port: 0,
      },
      manager: { backoffBaseMs: 100, stopGraceMs: 2000 },
      bridge: { heartbeatMs: 0, zombieMs: 0 },
    })
  }, 60_000)

  afterAll(async () => {
    await core?.stop().catch(() => undefined)
    core = undefined
    for (const k of envKeys) delete process.env[k]
    upstream?.server.close()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  }, 30_000)

  it(
    '九个服务全部 ready（session + loop + 4×provider + credentials + retry）',
    async () => {
      await waitFor(async () => {
        const res = await fetch(`${base()}/health`)
        if (!res.ok) return false
        const body = (await res.json()) as { services: Array<{ id: string; status: string }> }
        return serviceIds.every((id) => body.services.some((s) => s.id === id && s.status === 'ready'))
      }, 40_000, 'all services ready')
    },
    45_000,
  )

  it(
    '模型目录：llm.models.list(openai) → remote 列表（上游有 data）',
    async () => {
      const sse = await openSse(base(), '?topics=llm.models.**')
      try {
        const requestId = `models-remote-${Date.now()}`
        await post(base(), 'llm.models.list', { requestId, provider: 'openai' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.models.list.result' && e.payload.requestId === requestId),
          10_000,
          'llm.models.list.result(openai)',
        )
        const result = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'llm.models.list.result' && e.payload.requestId === requestId,
        )!
        console.log('MODELS-REMOTE>>>', JSON.stringify(result.payload))
        expect(result.payload.provider).toBe('openai')
        expect(result.payload.catalog).toBe('remote')
        expect(result.payload.models).toEqual(['gpt-4o-mini', 'gpt-4o'])
      } finally {
        sse.close()
      }
    },
    20_000,
  )

  it(
    '模型目录：上游 404 → 降级 static（catalog:static + 静态列表）',
    async () => {
      upstream!.state.modelsStatus = 'not-found'
      const sse = await openSse(base(), '?topics=llm.models.**')
      try {
        const requestId = `models-static-${Date.now()}`
        await post(base(), 'llm.models.list', { requestId, provider: 'anthropic' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.models.list.result' && e.payload.requestId === requestId),
          10_000,
          'llm.models.list.result(anthropic static)',
        )
        const result = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'llm.models.list.result' && e.payload.requestId === requestId,
        )!
        expect(result.payload.provider).toBe('anthropic')
        expect(result.payload.catalog).toBe('static')
        expect((result.payload.models as string[]).length).toBeGreaterThan(0)
      } finally {
        sse.close()
        upstream!.state.modelsStatus = 'ok'
      }
    },
    20_000,
  )

  it(
    'anthropic 流式：llm.request(anthropic) → 具名事件 → 逐步 token → finished(usage 归一)',
    async () => {
      const sse = await openSse(base(), '?topics=llm.**')
      try {
        const requestId = `anth-${Date.now()}`
        await post(base(), 'llm.request', {
          requestId,
          provider: 'anthropic',
          messages: [{ role: 'user', content: '你好' }],
        })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId),
          20_000,
          `llm.request.finished(anthropic) topics: ${parseSseEvents(sse.text()).map((e) => e.topic).join(',')}`,
        )
        const events = parseSseEvents(sse.text())
        console.log('ANTH>>>', events.map((e) => e.topic + ':' + JSON.stringify(e.payload)).join(' | '))
        const tokens = events.filter((e) => e.topic === 'llm.token.streamed' && e.payload.requestId === requestId)
        expect(tokens.map((t) => t.payload.token).join('')).toBe('你好')
        const started = events.find((e) => e.topic === 'llm.request.started' && e.payload.requestId === requestId)!
        expect(started.payload.provider).toBe('anthropic')
        const finished = events.find((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId)!
        expect((finished.payload as { usage?: { promptTokens: number; completionTokens: number } }).usage).toMatchObject({
          promptTokens: 5,
          completionTokens: 2,
        })
      } finally {
        sse.close()
      }
    },
    25_000,
  )

  it(
    '401 → unauthorized（非瞬态，retry 不重试，立即 failed）',
    async () => {
      upstream!.state.openaiStatus = 401
      const sse = await openSse(base(), '?topics=llm.request.failed,llm.token.streamed')
      try {
        const requestId = `unauth-${Date.now()}`
        await post(base(), 'llm.request', {
          requestId,
          provider: 'openai',
          messages: [{ role: 'user', content: 'hi' }],
        })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.failed' && e.payload.requestId === requestId),
          10_000,
          'llm.request.failed(unauthorized)',
        )
        const failed = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'llm.request.failed' && e.payload.requestId === requestId,
        )!
        expect((failed.payload.error as { code: string }).code).toBe('unauthorized')
        // 非瞬态 → 无重发（openaiHits 仍为 1）
        expect(upstream!.state.openaiHits).toBe(1)
      } finally {
        sse.close()
        upstream!.state.openaiStatus = 200
      }
    },
    15_000,
  )

  it(
    '429 → rate_limited（瞬态，llm-retry 退避重发 → 重试后成功）',
    async () => {
      upstream!.state.openai429Once = true
      upstream!.state.openaiStatus = 200
      upstream!.state.openaiHits = 0
      const sse = await openSse(base(), '?topics=llm.**')
      try {
        const requestId = `retry-${Date.now()}`
        await post(base(), 'llm.request', {
          requestId,
          provider: 'openai',
          messages: [{ role: 'user', content: 'hi' }],
        })
        // 第一次 429 → failed(rate_limited)
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.failed' && e.payload.requestId === requestId),
          10_000,
          'llm.request.failed(rate_limited)',
        )
        await sleep(2500)
        console.log('RETRY-EVS>>>', parseSseEvents(sse.text()).map((e) => e.topic + ':' + JSON.stringify(e.payload).slice(0, 80)).join(' | '))
        // retry 重发 → 第二次 200 → token + finished
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId),
          15_000,
          'llm.request.finished after retry',
        )
        const events = parseSseEvents(sse.text())
        const tokens = events.filter((e) => e.topic === 'llm.token.streamed' && e.payload.requestId === requestId)
        expect(tokens.map((t) => t.payload.token).join('')).toBe('你好')
        // 确实发生了一次重试（上游被请求 2 次：首次 429 + 重试 200）
        expect(upstream!.state.openaiHits).toBe(2)
      } finally {
        sse.close()
        upstream!.state.openai429Once = false
      }
    },
    20_000,
  )
})
