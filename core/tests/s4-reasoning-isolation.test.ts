/**
 * S4 集成冒烟 · 思考流不泄漏进正文 —— 真 Core + 真服务 + 假上游发 reasoning 块。
 *
 * 对应开发计划的验收句：
 * > 「端到端：假上游发 reasoning 块 → 断言 `{blockType:'reasoning'}` 可见 **且** 正文不含思维链」
 * > 「落库后重读该消息，`finishReason` 与 `usage` 仍在」
 *
 * ## 这个缺陷长什么样
 *
 * 修复前：`llm` 主位发 `llm.token.streamed` 不带块类型，`loop` 收到就往正文 buffer 里追加。
 * 于是 deepseek-reasoner 一类模型（恒思考）的思维链会**混进回答正文**并一起落库 ——
 * 用户看到的是「思考过程 + 答案」糊成一段。
 *
 * ## 为什么断言要覆盖三段
 *
 * ```
 * 假上游 reasoning delta
 *   → loop.token.streamed{blockType:'reasoning'}   前端据此分流渲染（S5 的折叠块）
 *   → assistant 消息 content 只有正文              用户看到的东西
 *   → 同一消息 reasoning 字段存着思维链            没丢，S5 有数据可折叠
 *   → 同一消息 finishReason / usage 在             S1 期间发现的静默丢字段，一并验
 * ```
 *
 * 只验第一段会漏掉「累积时没分流」，只验正文会漏掉「思维链被静默扔掉」。三段都要。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type Core } from '../src/main'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 假上游吐的内容：思维链一段 + 正文一段。两者内容明显不同，混了就能看出来 */
const THINKING = '让我想想这道题应该这么解'
const ANSWER = '答案是四十二'

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
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}; sse=${lastSse.slice(0, 600)}`)
    await sleep(80)
  }
}

let lastSse = ''

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
        lastSse = buf
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 假 openai 上游：先吐一个 `reasoning` 块，再吐 `content` 块。
 *
 * 用真实 provider 的 `reasoning` 字段（OpenRouter 也用它转译 anthropic 的 thinking），
 * 所以这条链路对 deepseek-reasoner / claude 经网关 都成立，不是为测试特造的形状。
 */
function startFakeUpstream(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    void (async () => {
      if (!url.includes('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      try {
        await readBody(req)
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (o: unknown): void => {
        res.write(`data: ${JSON.stringify(o)}\n\n`)
      }
      // 块 0：思维链
      send({ id: 's4', choices: [{ index: 0, delta: { reasoning: THINKING }, finish_reason: null }] })
      // 块 1：正文
      send({ id: 's4', choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }] })
      send({
        id: 's4',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

describe('S4 集成冒烟 · 思考流不泄漏进正文', () => {
  let core: Core | undefined
  let dataDir = ''
  let toolRoot = ''
  let up: { server: Server; baseUrl: string } | undefined

  const envKeys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'LLM_PROVIDER', 'LLM_TOOL_ROOT']
  const base = (): string => `http://127.0.0.1:${core!.port}`

  beforeAll(async () => {
    up = await startFakeUpstream()
    process.env.OPENAI_BASE_URL = up.baseUrl
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.LLM_PROVIDER = 'openai'
    toolRoot = mkdtempSync(path.join(tmpdir(), 'ost-s4-tools-'))
    process.env.LLM_TOOL_ROOT = toolRoot

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-s4-smoke-'))
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
    up?.server.close()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    if (toolRoot) rmSync(toolRoot, { recursive: true, force: true })
  }, 30_000)

  it(
    'reasoning 块可被识别；正文不含思维链；落库后 reasoning/finishReason/usage 仍在',
    async () => {
      const sse = await openSse(base(), '?topics=session.**,loop.**,llm.**')
      try {
        await waitFor(async () => {
          const res = await fetch(`${base()}/health`)
          if (!res.ok) return false
          const body = (await res.json()) as { services: Array<{ id: string; status: string }> }
          return ['session', 'loop', 'llm', 'llm-provider-openai'].every((id) =>
            body.services.some((svc) => svc.id === id && svc.status === 'ready'),
          )
        }, 40_000, 'services ready')

        const createId = `sess-${Date.now()}`
        await post(base(), 'session.create', { requestId: createId, title: 'S4' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createId),
          10_000,
          'session.create.result',
        )
        const sessionId = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === createId,
        )!.payload.sessionId as string

        const runId = `run-${Date.now()}`
        await post(base(), 'loop.run', { requestId: runId, sessionId, text: '这题怎么解', provider: 'openai' })
        await waitFor(
          () =>
            parseSseEvents(sse.text()).some(
              (e) => e.topic === 'loop.state.changed' && e.payload.requestId === runId && e.payload.state === 'idle',
            ),
          25_000,
          'loop idle',
        )

        const events = parseSseEvents(sse.text())
        const tokens = events.filter(
          (e) => e.topic === 'loop.token.streamed' && e.payload.requestId === runId,
        )

        // ① 前端看得见块类型：思维链被标成 reasoning，而不是混在 text 里
        const reasoningTokens = tokens.filter((e) => e.payload.blockType === 'reasoning')
        const textTokens = tokens.filter((e) => e.payload.blockType === 'text')
        expect(reasoningTokens.map((t) => t.payload.token).join('')).toBe(THINKING)
        expect(textTokens.map((t) => t.payload.token).join('')).toBe(ANSWER)

        // ② 事件流里 llm.token.streamed 也带上了（主位那一层）
        expect(
          parseSseEvents(sse.text()).some(
            (e) => e.topic === 'llm.token.streamed' && e.payload.blockType === 'reasoning',
          ),
          'llm 主位未标注 blockType',
        ).toBe(true)

        // ③ **正文不含思维链** —— 这是本次修复的核心断言
        const body = textTokens.map((t) => t.payload.token).join('')
        expect(body).toBe(ANSWER)
        expect(body).not.toContain('让我想想')

        // ④ 落库：重读该会话，正文干净，思维链单独存，finishReason/usage 也没丢
        const getId = `get-${Date.now()}`
        await post(base(), 'session.get', { requestId: getId, sessionId })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.get.result' && e.payload.requestId === getId),
          10_000,
          'session.get.result',
        )
        const messages = (
          parseSseEvents(sse.text()).find((e) => e.topic === 'session.get.result' && e.payload.requestId === getId)!
            .payload.session as { messages: Record<string, unknown>[] }
        ).messages
        const assistant = messages.find((m) => m.role === 'assistant') as
          | { content?: string; reasoning?: string; finishReason?: string; usage?: { promptTokens: number; completionTokens: number } }
          | undefined
        expect(assistant, 'assistant 消息没落库').toBeDefined()
        expect(assistant!.content).toBe(ANSWER)
        expect(assistant!.content).not.toContain('让我想想')
        // 思维链没被静默扔掉 —— S5 的折叠块要靠它
        expect(assistant!.reasoning).toBe(THINKING)
        // S1 期间发现的另一个丢字段，一并验
        expect(assistant!.finishReason).toBe('stop')
        expect(assistant!.usage).toMatchObject({ promptTokens: 9, completionTokens: 4 })
      } finally {
        sse.close()
      }
    },
    90_000,
  )
})
