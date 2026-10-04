/**
 * P7 集成冒烟 · 最小工具循环 —— 真 Core + 真 9 服务 + 本地假上游。
 *
 * 验证「模型发起工具调用 → loop 执行 → 结果回填 → 模型据此续答 → stop」整条链：
 *
 * ```
 * loop.run ─► llm.request ─► llm 主位 ─► openai provider ─► 假上游（返回 tool_calls）
 *                ▲                                          │
 *                │                                     llm.request.tool_call
 *                │                                          ▼
 *                └──── loop 执行 list_dir ── role:'tool' 回填 ─┘（第二轮请求）
 * ```
 *
 * 断言点（每一条都是「UI 上看得见的东西真的发生了」）：
 * 1. 第一轮请求体带 `tools`（中立 ToolSpec → openai wire `{type:'function',...}`）；
 * 2. 模型发起的 tool_call 经主位拼装成完整 `{id,name,arguments}` → loop 执行成功；
 * 3. `loop.tool.executed` 事件带 ok/summary（前端工具块的即时反馈源）；
 * 4. 第二轮请求体里出现 `role:'tool'` + `tool_call_id`（否则模型看不到结果，上游也会 400）；
 * 5. 会话最终落 4 条消息：user / assistant(toolCalls) / tool / assistant(最终答复)；
 * 6. `loop.state.changed` 只在最后收一次 idle（工具轮中间不得回 idle）。
 *
 * 假上游：`OPENAI_BASE_URL` 指本文件起的本地 server；首次请求吐 tool_calls，之后吐正文。
 * 无需真实 API key / 外网。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

interface WireMessage {
  role: string
  content: string
  tool_call_id?: string
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}

interface UpstreamState {
  /** 收到的请求体（按序留证） */
  bodies: { model?: string; tools?: unknown[]; messages?: WireMessage[] }[]
  /** 工具调用的最终答复文本 */
  finalText: string
}

/**
 * 假上游（openai 兼容）：
 * - 第 1 次 `/chat/completions` → `delta.tool_calls`（name 与**空** arguments 同帧，踩 P2 WS-10 记的 wire 坑）
 *   + 第二帧补 arguments + `finish_reason:'tool_calls'`
 * - 第 2 次起 → 正常正文 + `finish_reason:'stop'`
 */
function startFakeUpstream(): Promise<{ server: Server; baseUrl: string; state: UpstreamState }> {
  const state: UpstreamState = { bodies: [], finalText: '目录里有 a.txt' }
  const send = (res: ServerResponse, o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)

  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (!url.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    void (async () => {
      let parsed: { model?: string; tools?: unknown[]; messages?: WireMessage[] } = {}
      try {
        parsed = JSON.parse(await readBody(req)) as typeof parsed
      } catch {
        /* 留空 */
      }
      state.bodies.push(parsed)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })

      if (state.bodies.length === 1) {
        // 首帧：name 与空 arguments 同帧（真实 openai 行为）
        send(res, {
          id: 'x',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '' } }] }, finish_reason: null }],
        })
        send(res, { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":""}' } }] }, finish_reason: null }] })
        send(res, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 0 } })
      } else {
        for (const c of [...state.finalText]) {
          send(res, { id: 'x', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })
        }
        send(res, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, state })
    })
  })
}

describe('P7 集成冒烟 · 最小工具循环', () => {
  let core: Core | undefined
  let dataDir = ''
  let toolRoot = ''
  let upstream: { server: Server; baseUrl: string; state: UpstreamState } | undefined

  const envKeys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'LLM_PROVIDER', 'LLM_TOOL_ROOT']
  const base = (): string => `http://127.0.0.1:${core!.port}`

  beforeAll(async () => {
    upstream = await startFakeUpstream()
    process.env.OPENAI_BASE_URL = `${upstream.baseUrl}/v1`
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    process.env.LLM_PROVIDER = 'openai'

    // 工具根目录：list_dir 的路径守卫基准（P7 安全边界：只读 + 锁在 root 内）
    toolRoot = mkdtempSync(path.join(tmpdir(), 'ost-p7-tools-'))
    writeFileSync(path.join(toolRoot, 'a.txt'), 'hello')
    process.env.LLM_TOOL_ROOT = toolRoot

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-p7-smoke-'))
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
    if (toolRoot) rmSync(toolRoot, { recursive: true, force: true })
  }, 30_000)

  it(
    '端到端：tool_calls → 执行 list_dir → role:tool 回填 → 第二轮续答 → stop',
    async () => {
      // message.appended 属 message.**（不归 session.** 前缀 —— 三个都要订）
      const sse = await openSse(base(), '?topics=session.**,message.**,loop.**')
      try {
        await waitFor(async () => {
          const res = await fetch(`${base()}/health`)
          if (!res.ok) return false
          const body = (await res.json()) as { services: Array<{ id: string; status: string }> }
          return ['loop', 'llm', 'llm-provider-openai', 'session'].every((id) =>
            body.services.some((s) => s.id === id && s.status === 'ready'),
          )
        }, 40_000, 'services ready')

        // 1) 建会话
        const createId = `sess-${Date.now()}`
        await post(base(), 'session.create', { requestId: createId, title: '工具循环' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createId),
          10_000,
          'session.create.result',
        )
        const created = parseSseEvents(sse.text()).find((e) => e.topic === 'session.create.result' && e.payload.requestId === createId)!
        const sessionId = created.payload.sessionId as string

        // 2) 发问（带 provider/model —— P4 参数链路）
        const a = `run-${Date.now()}`
        await post(base(), 'loop.run', {
          requestId: a,
          sessionId,
          text: '看看目录里有什么',
          provider: 'openai',
          model: 'gpt-4o-mini',
        })

        // 3) 等本轮跑完（idle）
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a && e.payload.state === 'idle'),
          30_000,
          `loop idle topics: ${parseSseEvents(sse.text()).map((e) => e.topic).join(',')}`,
        )
        const events = parseSseEvents(sse.text())

        // 断言①：第一轮请求带 tools（openai wire 形状）
        expect(upstream!.state.bodies.length, '上游应收到两轮请求').toBe(2)
        const first = upstream!.state.bodies[0]
        expect(first.tools, '第一轮请求未带 tools（模型无从发起 tool_calls）').toBeTruthy()
        expect((first.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(['read_file', 'list_dir'])

        // 断言②：工具执行事件（前端工具块的即时反馈源）
        // 工具调用 id 是**主位中立化的块 id**（`c-<requestId>-<index>-<seq>`），不是上游的 `call_1`；
        // 不变式是「同一个 id 贯穿 assistant.toolCalls / role:tool / 下一轮 wire 的 tool_call_id」。
        const executed = events.filter((e) => e.topic === 'loop.tool.executed' && e.payload.requestId === a)
        expect(executed).toHaveLength(1)
        expect(executed[0].payload).toMatchObject({ name: 'list_dir', ok: true })
        expect(String(executed[0].payload.summary)).toContain('a.txt')
        const toolCallId = executed[0].payload.toolCallId as string
        expect(toolCallId).toBeTruthy()

        // 断言③：第二轮请求带 role:'tool' + tool_call_id（且与 assistant.tool_calls[].id 相同）
        const second = upstream!.state.bodies[1]
        const toolMsg = (second.messages ?? []).find((m) => m.role === 'tool')
        expect(toolMsg, '第二轮请求缺 role:tool（模型看不到工具结果）').toBeTruthy()
        expect(toolMsg!.tool_call_id).toBe(toolCallId)
        // 模型也要看到自己上一轮发起过什么
        const assistantWithCalls = (second.messages ?? []).find((m) => m.role === 'assistant' && m.tool_calls?.length)
        expect(assistantWithCalls?.tool_calls?.[0]).toMatchObject({ id: toolCallId, function: { name: 'list_dir' } })

        // 断言④：会话落了 4 条消息
        // 注意：`loop.state.changed{idle}` 由 loop 发，而 `message.appended` 由 session 异步回
        // （message.append 是命令→结果路径）——idle 可能先到，故这里显式等消息条数
        await waitFor(
          () => parseSseEvents(sse.text()).filter((e) => e.topic === 'message.appended' && e.payload.sessionId === sessionId).length >= 4,
          10_000,
          '4 条 message.appended',
        )
        const appended = parseSseEvents(sse.text()).filter((e) => e.topic === 'message.appended' && e.payload.sessionId === sessionId)
        const roles = appended.map((e) => (e.payload.message as { role: string }).role)
        expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])
        const toolCallMsg = appended[1].payload.message as { toolCalls?: { id: string; name: string }[] }
        expect(toolCallMsg.toolCalls?.[0]).toMatchObject({ name: 'list_dir' })
        expect(toolCallMsg.toolCalls?.[0]?.id).toBe(toolCallId)
        const toolMsgRow = appended[2].payload.message as { toolCallId?: string; toolName?: string }
        expect(toolMsgRow).toMatchObject({ toolCallId, toolName: 'list_dir' })
        expect(String(appended[3].payload.message ? (appended[3].payload.message as { content: string }).content : '')).toBe('目录里有 a.txt')

        // 断言⑤：工具轮中间没有多余的 idle（state 只在最后收一次）
        const states = events.filter((e) => e.topic === 'loop.state.changed' && e.payload.requestId === a)
        expect(states).toHaveLength(2)
        expect(states[0].payload.state).toBe('running')
        expect(states[1].payload.state).toBe('idle')
      } finally {
        sse.close()
      }
    },
    60_000,
  )
})