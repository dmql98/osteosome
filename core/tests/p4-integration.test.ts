/**
 * P4 集成冒烟（WS-5）—— 真 Core + 6 服务，验证 P4 三块新增能力。
 *
 * 在 P3（四服务会话编排）基础上，本文件聚焦 P4 独有的链路：
 *  1) 模型目录：`llm.models.list` → provider 拉上游 /models → `llm.models.list.result`
 *     （remote：上游有 data；static：上游 404/失败 → 静态兜底）
 *  2) 第二个厂商实例：openrouter 走同一个 provider 进程，claude 经网关转成 openai 形状的 SSE
 *     → StreamChunk（验证「加厂商 = 加一行预设」，且网关路径与直连 openai 行为一致）
 *  3) 错误码化：401 → unauthorized（非瞬态，retry 立即失败不重试）；
 *     429 → rate_limited（瞬态，llm-retry 执行器按退避重发 → 重试成功）
 *  4) 参数链路（P4 WS-2）：`loop.run` 的 provider/model/thinking 一路落到上游请求体
 *     （统一走 openai wire 的 `reasoning_effort`；原先 anthropic 的 thinking.budget_tokens
 *      已随原生 wire 下线，网关侧由 openrouter 负责映射）
 *
 * 假上游：OPENAI_BASE_URL / OPENROUTER_BASE_URL 均可配（S1 设计），指向本测试起的本地
 * HTTP server——/v1/chat/completions 与 /openrouter/chat/completions（两家分路径，才能断言
 * 「打到的是那一家」）+ 模型目录 /models，按需注入 401/429，并留证最后一次请求体。
 * 无需真实 API key / 外网。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
 * 假上游：一个 HTTP server 同时充当 openai / openrouter 两家上游。
 * - `/v1/chat/completions`：openai 兼容 SSE（`data:` 帧 + `[DONE]`）
 * - `/openrouter/chat/completions`：网关转译后的形状 —— **与上面同一种**（这正是要验的
 *   事：claude 经网关回来，翻译层看不出区别）
 * - `/models`：模型目录（两家都指向它；默认 200 返回 data）
 *   - `state.modelsStatus`: 'ok' | 'not-found' | 'bad-json' 控制远端/静态降级
 * - 注入开关：`state.openaiStatus` / `state.openrouterStatus` 设 HTTP 状态（401/429）模拟错误
 * - **请求体留证**：`state.openaiBody` / `state.openrouterBody` 记最后一次请求体
 *   （P4 WS-2 用来实证 loop.run 的 model/thinking 真的落到上游 wire）
 * - 路径分开而不是靠 model 名分辨：这样「openrouter 那次请求」能被独立计数与留证，
 *   顺带证明多实例真的按各自 baseUrl 路由（S1）。
 */
interface UpstreamState {
  text: string
  models: string[]
  modelsStatus: 'ok' | 'not-found' | 'bad-json'
  openaiStatus: number
  /** 429Once：openai 首次请求 429（触发 retry），之后自动 200（验证重试成功） */
  openai429Once: boolean
  openrouterStatus: number
  openaiHits: number
  openrouterHits: number
  /** 最后一次 openai 兼容请求体（JSON 解析失败则留原文） */
  openaiBody: Record<string, unknown> | null
  /** 最后一次 openrouter（claude 经网关）请求体 */
  openrouterBody: Record<string, unknown> | null
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function startFakeUpstream(): Promise<{ server: Server; baseUrl: string; state: UpstreamState }> {
  const state: UpstreamState = {
    text: '你好',
    models: ['gpt-4o-mini', 'gpt-4o'],
    modelsStatus: 'ok',
    openaiStatus: 200,
    openai429Once: false,
    openrouterStatus: 200,
    openaiHits: 0,
    openrouterHits: 0,
    openaiBody: null,
    openrouterBody: null,
  }
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    void handle(req, res, url)
  })
  async function handle(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
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

    // openrouter（claude 经网关）→ 与直连 openai 完全同形状的 SSE
    if (url.includes('/openrouter/chat/completions')) {
      state.openrouterHits += 1
      state.openrouterBody = parseBody(await readBody(req))
      if (state.openrouterStatus !== 200) {
        res.writeHead(state.openrouterStatus).end()
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

    // openai 兼容 /v1/chat/completions（排除 openrouter 那条路径：不靠分支顺序兜底）
    if (url.includes('/chat/completions') && !url.includes('/openrouter/')) {
      state.openaiHits += 1
      state.openaiBody = parseBody(await readBody(req))
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
  }
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, state })
    })
  })
}

describe('P4 集成冒烟 · 模型目录 + 第二厂商实例 + 错误码化', () => {
  let core: Core | undefined
  let dataDir = ''
  let upstream: { server: Server; baseUrl: string; state: UpstreamState } | undefined

  const envKeys = [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'LLM_PROVIDER',
  ]

  const base = (): string => `http://127.0.0.1:${core!.port}`
  const serviceIds = ['llm', 'session', 'loop', 'credentials', 'llm-provider-openai', 'llm-retry']

  beforeAll(async () => {
    upstream = await startFakeUpstream()
    process.env.OPENAI_BASE_URL = `${upstream.baseUrl}/v1`
    // openrouter 走独立子路径：两家请求能被分别计数/留证
    process.env.OPENROUTER_BASE_URL = `${upstream.baseUrl}/openrouter`
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
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
    '六个服务全部 ready（session + loop + provider + credentials + retry）',
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
        await post(base(), 'llm.models.list', { requestId, provider: 'openrouter' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.models.list.result' && e.payload.requestId === requestId),
          10_000,
          'llm.models.list.result(openrouter static)',
        )
        const result = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'llm.models.list.result' && e.payload.requestId === requestId,
        )!
        expect(result.payload.provider).toBe('openrouter')
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
    '第二厂商实例流式：llm.request(openrouter) → 网关转译的 openai 形状 SSE → token + usage 归一',
    async () => {
      const sse = await openSse(base(), '?topics=llm.**')
      try {
        const requestId = `or-${Date.now()}`
        const openaiHitsBefore = upstream!.state.openaiHits
        await post(base(), 'llm.request', {
          requestId,
          provider: 'openrouter',
          model: 'anthropic/claude-3.5-sonnet',
          messages: [{ role: 'user', content: '你好' }],
        })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId),
          20_000,
          `llm.request.finished(openrouter) topics: ${parseSseEvents(sse.text()).map((e) => e.topic).join(',')}`,
        )
        const events = parseSseEvents(sse.text())
        const tokens = events.filter((e) => e.topic === 'llm.token.streamed' && e.payload.requestId === requestId)
        expect(tokens.map((t) => t.payload.token).join('')).toBe('你好')
        const started = events.find((e) => e.topic === 'llm.request.started' && e.payload.requestId === requestId)!
        expect(started.payload.provider).toBe('openrouter')
        const finished = events.find((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId)!
        expect((finished.payload as { usage?: { promptTokens: number; completionTokens: number } }).usage).toMatchObject({
          promptTokens: 3,
          completionTokens: 2,
        })
        // 路由确实按实例走：打的是 openrouter 那条路径，没碰 openai 的
        expect(upstream!.state.openrouterHits).toBe(1)
        expect(upstream!.state.openaiHits).toBe(openaiHitsBefore)
        // claude 的模型名原样送上网关
        expect(upstream!.state.openrouterBody!.model).toBe('anthropic/claude-3.5-sonnet')
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

  /**
   * P4 WS-2 参数链路端到端：前端发的 `loop.run { provider, model, thinking }`
   * 必须一路落到上游请求体 —— 这是「UI 上能选的参数真的有效果」的最终证据
   * （P3 时这三项全是装饰：provider 被 loop 硬编码成 env、model 不带、思考强度不存在）。
   */
  it(
    '参数链路：loop.run(provider/model/thinking) → 上游 body 收到 model + reasoning_effort',
    async () => {
      const sse = await openSse(base(), '?topics=session.**,loop.**')
      try {
        // 1) 建会话
        const createId = `sess-${Date.now()}`
        await post(base(), 'session.create', { requestId: createId, title: '参数链路' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createId),
          10_000,
          'session.create.result',
        )
        const created = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === createId,
        )!
        const sessionId = created.payload.sessionId as string
        expect(sessionId).toBeTruthy()

        // 2) 带参发问
        const a = `run-${Date.now()}`
        await post(base(), 'loop.run', {
          requestId: a,
          sessionId,
          text: '带参发问',
          provider: 'openai',
          model: 'gpt-4o',
          thinking: 'high',
        })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a && e.payload.state === 'idle'),
          15_000,
          `loop.state.changed(idle) topics: ${parseSseEvents(sse.text()).map((e) => e.topic).join(',')}`,
        )

        // 3) 上游真的收到了
        const body = upstream!.state.openaiBody
        expect(body, '上游未收到 openai 请求').toBeTruthy()
        expect(body!.model).toBe('gpt-4o')
        expect(body!.reasoning_effort).toBe('high')
        // 多轮上下文仍在（system + user）
        expect(Array.isArray(body!.messages)).toBe(true)
        expect((body!.messages as unknown[]).length).toBeGreaterThanOrEqual(2)
      } finally {
        sse.close()
      }
    },
    30_000,
  )

  it(
    '参数链路：思考强度对 claude 也只走 reasoning_effort（统一 wire，无 thinking.budget_tokens）',
    async () => {
      const sse = await openSse(base(), '?topics=llm.request.finished,llm.request.failed')
      try {
        const requestId = `or-think-${Date.now()}`
        await post(base(), 'llm.request', {
          requestId,
          provider: 'openrouter',
          model: 'anthropic/claude-3.5-sonnet',
          messages: [{ role: 'user', content: '想一下' }],
          thinking: 'medium',
          temperature: 0.7,
        })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => (e.topic === 'llm.request.finished' || e.topic === 'llm.request.failed') && e.payload.requestId === requestId),
          20_000,
          'openrouter thinking 请求收尾',
        )
        const body = upstream!.state.openrouterBody
        expect(body, '上游未收到 openrouter 请求').toBeTruthy()
        // 中立 medium → wire reasoning_effort（claude 的 thinking 预算由网关侧映射）
        expect(body!.reasoning_effort).toBe('medium')
        // 原生 wire 已下线：不得再出现 anthropic 私有字段
        expect(body!.thinking).toBeUndefined()
        // 统一 openai 路径照常下发 temperature（原先 anthropic 的「thinking 时不下发」随 wire 一起没了）
        expect(body!.temperature).toBe(0.7)
      } finally {
        sse.close()
      }
    },
    30_000,
  )
})
