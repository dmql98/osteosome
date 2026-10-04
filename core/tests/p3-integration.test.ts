/**
 * P3 集成冒烟（WS-6）—— 起真实 Core + session + loop + llm 四服务，跑通会话编排链路。
 *
 * 链路：POST `loop.run` → loop 先落 user 消息(session.message.append) → llm.request(B) →
 *   llm-provider-openai（凭证经 credentials 能力位）→ 本地假上游 SSE → `loop.token.streamed`(A)
 *   → assistant 消息落库 → `loop.state.changed`(idle)。取消经 `loop.cancel` 传播到 llm.cancel。
 *
 * 假上游：`llm-provider-openai` 的 `OPENAI_BASE_URL` 经 env 可配（WS-6 设计），这里指向
 * 本测试起的本地 SSE server——因此不需要真实 API key / 外网，且凭证仍走真实 credentials 服务。
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
 * 起本地假 openai 上游（/chat/completions SSE）。
 * - `state.text`：回给模型的固定回答（默认 '你好'）。
 * - `state.echoMessages`：为 true 时，把请求里的 messages 条数与角色回显进回答，
 *   供多轮测试断言「loop 真的把上文带上了」。
 * - `state.lastRequestMessages`：记录最后一次请求的 messages（多轮断言用）。
 */
function startFakeUpstream(): Promise<{ server: Server; baseUrl: string; state: { text: string; echoMessages: boolean; lastRequestMessages: unknown[] } }> {
  const state = { text: '你好', echoMessages: false, lastRequestMessages: [] as unknown[] }
  const server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let messages: { role?: string; content?: string }[] = []
      try {
        const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] }
        messages = parsed.messages ?? []
        state.lastRequestMessages = parsed.messages ?? []
      } catch {
        /* 忽略畸形 body */
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const answer = state.echoMessages
        ? `n=${messages.length} last=${messages[messages.length - 1]?.content ?? ''}`
        : state.text
      const chars = [...answer]
      for (const c of chars) {
        send({ id: 'x', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })
      }
      send({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: chars.length } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, state })
    })
  })
}

describe('P3 集成冒烟 · session + loop + llm 四服务', () => {
  let core: Core | undefined
  let dataDir = ''
  let upstream:
    | { server: Server; baseUrl: string; state: { text: string; echoMessages: boolean; lastRequestMessages: unknown[] } }
    | undefined
  const envKeys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'LLM_PROVIDER']

  const base = (): string => `http://127.0.0.1:${core!.port}`
  const serviceIds = ['llm', 'session', 'loop', 'credentials', 'llm-provider-openai', 'llm-retry']

  beforeAll(async () => {
    upstream = await startFakeUpstream()
    process.env.OPENAI_BASE_URL = upstream.baseUrl
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    process.env.LLM_PROVIDER = 'openai' // loop 打到 openai 位（假上游）

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-p3-smoke-'))
    core = await startCore({
      argv: [],
      config: {
        pluginsDir: path.join(REPO_ROOT, 'plugins'),
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
    '八个服务全部 ready（session + loop + 5×llm）',
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
    'session.create → session.created 事件 + list 可见',
    async () => {
      const sse = await openSse(base(), '?topics=session.**,message.**')
      try {
        const requestId = `create-${Date.now()}`
        await post(base(), 'session.create', { requestId, title: '集成会话' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === requestId),
          10_000,
          'session.create.result',
        )
        const created = parseSseEvents(sse.text()).find((e) => e.topic === 'session.created')!
        expect(created.payload.title).toBe('集成会话')
        // list 可见
        const listReq = `list-${Date.now()}`
        await post(base(), 'session.list', { requestId: listReq })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.list.result' && e.payload.requestId === listReq),
          10_000,
          'session.list.result',
        )
        const list = parseSseEvents(sse.text()).find((e) => e.topic === 'session.list.result' && e.payload.requestId === listReq)!
        expect((list.payload.sessions as unknown[]).length).toBeGreaterThan(0)
      } finally {
        sse.close()
      }
    },
    20_000,
  )

  it(
    'loop.run → 先落 user 消息 → loop.token.streamed(A) 逐步累积 → assistant 落库 → state idle',
    async () => {
      const sse = await openSse(base(), '?topics=session.**,message.**,loop.**')
      try {
        // 建会话
        const createReq = `run-create-${Date.now()}`
        await post(base(), 'session.create', { requestId: createReq, title: '编排会话' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createReq),
          10_000,
          'session.create.result',
        )
        const sessionId = parseSseEvents(sse.text()).find((e) => e.topic === 'session.create.result' && e.payload.requestId === createReq)!.payload
          .sessionId as string

        // 发问
        const a = `run-${Date.now()}`
        await post(base(), 'loop.run', { requestId: a, sessionId, text: '你好' })

        // 等待 user 消息落库（message.appended role:user）
        await waitFor(
          () =>
            parseSseEvents(sse.text()).some(
              (e) => e.topic === 'message.appended' && (e.payload.message as { role: string })?.role === 'user',
            ),
          15_000,
          'user message appended',
        )

        // 等待 loop 跑完（state idle）
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a && e.payload.state === 'idle'),
          20_000,
          `loop idle (topics seen: ${parseSseEvents(sse.text()).map((e) => e.topic).join(', ')})`,
        )
        // assistant 的 message.appended 由 session 异步发（message.append 是命令→结果路径），
        // 可能晚于 idle —— 显式等它，别赌时序（高负载下曾假红）
        await waitFor(
          () =>
            parseSseEvents(sse.text()).some(
              (e) => e.topic === 'message.appended' && (e.payload.message as { role: string })?.role === 'assistant',
            ),
          10_000,
          'assistant message appended',
        )

        const events = parseSseEvents(sse.text())
        // 逐步 token（A 可见，累积成 '你好'）
        const tokens = events.filter((e) => e.topic === 'loop.token.streamed' && e.payload.requestId === a)
        expect(tokens.map((t) => t.payload.token).join('')).toBe('你好')
        // B 不泄前端（loop.token.streamed 全部带 A）
        expect(tokens.every((t) => t.payload.requestId === a)).toBe(true)
        // assistant 消息落库
        const assistant = events.find(
          (e) => e.topic === 'message.appended' && (e.payload.message as { role: string })?.role === 'assistant',
        )
        expect((assistant!.payload.message as { content: string }).content).toBe('你好')
        // state 切换：running → idle
        const states = events.filter((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a).map((e) => e.payload.state)
        expect(states).toEqual(['running', 'idle'])
      } finally {
        sse.close()
      }
    },
    35_000,
  )

  it(
    '第二轮带上文：loop 拉 session.get 历史 → 拼多轮 → llm.request messages 含 system + 全部历史',
    async () => {
      const sse = await openSse(base(), '?topics=session.**,message.**,loop.**')
      try {
        upstream!.state.echoMessages = true

        // 建会话
        const createReq = `mr-create-${Date.now()}`
        await post(base(), 'session.create', { requestId: createReq, title: '多轮会话' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createReq),
          10_000,
          'session.create.result',
        )
        const sessionId = parseSseEvents(sse.text()).find((e) => e.topic === 'session.create.result' && e.payload.requestId === createReq)!
          .payload.sessionId as string

        // 第一轮
        const a1 = `mr-1-${Date.now()}`
        await post(base(), 'loop.run', { requestId: a1, sessionId, text: '第一问' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a1 && e.payload.state === 'idle'),
          20_000,
          'round 1 idle',
        )
        // 第一轮 messages = [system, user '第一问']
        expect(upstream!.state.lastRequestMessages).toHaveLength(2)

        // 第二轮（同会话）
        const a2 = `mr-2-${Date.now()}`
        await post(base(), 'loop.run', { requestId: a2, sessionId, text: '第二问' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a2 && e.payload.state === 'idle'),
          20_000,
          'round 2 idle',
        )

        // 第二轮 messages = [system, user '第一问', assistant 'n=2 last=第一问', user '第二问']
        const messages = upstream!.state.lastRequestMessages as { role: string; content: string }[]
        expect(messages).toHaveLength(4)
        expect(messages[0].role).toBe('system')
        expect(messages[1]).toMatchObject({ role: 'user', content: '第一问' })
        expect(messages[2].role).toBe('assistant')
        expect(messages[3]).toMatchObject({ role: 'user', content: '第二问' })

        upstream!.state.echoMessages = false
      } finally {
        sse.close()
      }
    },
    45_000,
  )

  it(
    '空 sessionId 的 loop.run → loop.run.failed{invalid_request}，不崩',
    async () => {
      const sse = await openSse(base(), '?topics=loop.**')
      try {
        const a = `bad-${Date.now()}`
        await post(base(), 'loop.run', { requestId: a, sessionId: '', text: 'hi' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.run.failed' && e.payload.requestId === a),
          10_000,
          'loop.run.failed (invalid_request)',
        )
        const failed = parseSseEvents(sse.text()).find((e) => e.topic === 'loop.run.failed' && e.payload.requestId === a)!
        expect((failed.payload.error as { code: string }).code).toBe('invalid_request')
      } finally {
        sse.close()
      }
    },
    15_000,
  )
})
