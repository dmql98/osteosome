/**
 * P2 集成冒烟（WS-9）—— 起真实 Core + 全部 LLM 服务，跑通整条中立流链路。
 *
 * 链路：POST /api/command `llm.request` → llm 主位查 provider 路由 → `llm.provider.request`
 *   → llm-provider-openai（凭证经 credentials 能力位解析）→ 本地假上游 SSE
 *   → `llm.provider.chunk` → 主位翻译 `llm.token.streamed` / `llm.request.finished`
 *   → llm-retry 记账发 `llm.metrics.usage` → 前端 SSE。
 *
 * 假上游：`llm-provider-openai` 的 `OPENAI_BASE_URL` 经 env 可配（WS-6 设计），这里指向
 * 本测试起的本地 SSE server——因此不需要真实 API key / 外网，且凭证仍走真实 credentials 服务。
 */
import { spawnSync } from 'node:child_process'
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
      if (typeof parsed.topic === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        out.push(parsed)
      }
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

/** 起本地假 openai 上游（/chat/completions SSE） */
function startFakeUpstream(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] })
    send({ id: 'x', choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] })
    send({
      id: 'x',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` })
    })
  })
}

describe('P2 集成冒烟 · 四服务中立流链路', () => {
  let core: Core | undefined
  let dataDir = ''
  let upstream: { server: Server; baseUrl: string } | undefined
  // deepseek/openrouter 的 key 故意留着：它们现在不各自起进程，而是让 llm-provider-openai
  // 额外注册两个厂商实例（端点用各家真地址，本测试不发请求过去）——顺带证明单进程多注册
  // 不会妨碍主链路。
  const envKeys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']

  const base = (): string => `http://127.0.0.1:${core!.port}`
  const serviceIds = ['llm', 'credentials', 'llm-provider-openai', 'llm-retry']

  beforeAll(async () => {
    upstream = await startFakeUpstream()
    // 凭证走真实 credentials 服务（env: v1）——用假 key 即可，无需外网
    process.env.OPENAI_BASE_URL = upstream.baseUrl
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-p2-smoke-'))
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
    '六个服务全部 ready（llm + 3 provider + credentials + llm-retry）',
    async () => {
      await waitFor(async () => {
        const res = await fetch(`${base()}/health`)
        if (!res.ok) return false
        const body = (await res.json()) as { services: Array<{ id: string; status: string }> }
        return serviceIds.every((id) => body.services.some((s) => s.id === id && s.status === 'ready'))
      }, 40_000, 'all LLM services ready')
    },
    45_000,
  )

  it(
    '发 llm.request(openai) → SSE 逐步 token → finished → llm.metrics.usage 记账',
    async () => {
      const sse = await openSse(base(), '?topics=llm.**,credentials.**')
      try {
        const requestId = `p2-smoke-${Date.now()}`
        const res = await fetch(`${base()}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: 'llm.request',
            payload: { requestId, provider: 'openai', messages: [{ role: 'user', content: '你好' }] },
          }),
        })
        expect(res.status).toBe(202)

        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId),
          20_000,
          `llm.request.finished (topics seen: ${parseSseEvents(sse.text()).map((e) => e.topic).join(', ')})`,
        )
        const events = parseSseEvents(sse.text())
        const tokens = events.filter((e) => e.topic === 'llm.token.streamed' && e.payload.requestId === requestId)
        const finished = events.find((e) => e.topic === 'llm.request.finished' && e.payload.requestId === requestId)
        const usage = events.find((e) => e.topic === 'llm.metrics.usage' && e.payload.requestId === requestId)

        // 逐步 token：字序正确、index 递增
        expect(tokens.map((e) => e.payload.token).join('')).toBe('你好')
        expect(tokens.map((e) => e.payload.index)).toEqual([0, 1])
        expect(finished).toMatchObject({ payload: { finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2 } } })
        // llm-retry 旁路记账（usage 来自 finished）
        expect(usage).toMatchObject({ payload: { provider: 'openai', usage: { promptTokens: 3, completionTokens: 2 } } })
      } finally {
        sse.close()
      }
    },
    30_000,
  )

  it(
    '未注册 provider → llm.request.failed{unsupported_provider}',
    async () => {
      const sse = await openSse(base(), '?topics=llm.request.failed')
      try {
        const requestId = `p2-unsupported-${Date.now()}`
        await fetch(`${base()}/api/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: 'llm.request',
            payload: { requestId, provider: 'nope', messages: [{ role: 'user', content: 'hi' }] },
          }),
        })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'llm.request.failed' && e.payload.requestId === requestId),
          10_000,
          'unsupported_provider failed',
        )
        const failed = parseSseEvents(sse.text()).find((e) => e.topic === 'llm.request.failed' && e.payload.requestId === requestId)
        expect((failed!.payload.error as { code: string }).code).toBe('unsupported_provider')
      } finally {
        sse.close()
      }
    },
    15_000,
  )
})
