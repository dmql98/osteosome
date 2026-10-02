/**
 * S1 集成冒烟 · 通用 provider 多实例 —— 真 Core + 真服务 + 两个本地假上游。
 *
 * 验证「一个 provider 进程服务多家 openai 兼容厂商」这件事真的成立：
 *
 * ```
 * agent.run{provider:'deepseek'} ──► llm 主位 ──► llm-provider-openai（单进程）
 *                                        │              ├─ deepseek 实例 → DEEPSEEK_BASE_URL
 *                                        └─ openai   实例 → OPENAI_BASE_URL
 * ```
 *
 * 三条断言（**用行为而非注册事件**）：
 * 1. `llm.provider.registered` 在服务启动瞬间就发完了，而 Bus 没有订阅回放 ——
 *    冒烟阶段才开的 SSE 永远看不到它们，所以「注册了几家」不能靠事件断言；
 * 2. 「这家能不能用」的真证据是：指定它发问能打通，且模型名一路到**它自己的**上游；
 * 3. 未配置凭证的厂商**不注册** → `unsupported_provider`，且一个上游请求都不发出去
 *    （这就是「存在性由配置决定」）。
 *
 * 为什么要独立文件而不是并进 p7-integration：那边把 `OPENAI_BASE_URL` 指到自己的假上游，
 * 本文件要让 deepseek 与 openai 指向**不同**上游才能证明「按 provider 名路由」，两个假上游
 * 放在同一个 describe 里会互相干扰（首个请求决定后续所有请求拿到哪份响应）。
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 一个只记模型名、回固定正文的假 openai 上游 */
function startFakeUpstream(tag: string): Promise<{ server: Server; baseUrl: string; models: string[] }> {
  const models: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    void (async () => {
      if (url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: models.map((id) => ({ id, object: 'model' })) }),
        )
        return
      }
      if (!url.includes('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      let model = ''
      try {
        const parsed = JSON.parse(await readBody(req)) as { model?: string }
        model = typeof parsed.model === 'string' ? parsed.model : ''
      } catch {
        /* 留空 */
      }
      models.push(model)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (o: unknown): void => {
        res.write(`data: ${JSON.stringify(o)}\n\n`)
      }
      for (const c of [...tag]) {
        send({ id: tag, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })
      }
      send({ id: tag, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, models })
    })
  })
}

describe('S1 集成冒烟 · 通用 provider 多实例', () => {
  let core: Core | undefined
  let dataDir = ''
  let toolRoot = ''
  let openaiUp: { server: Server; baseUrl: string; models: string[] } | undefined
  let deepseekUp: { server: Server; baseUrl: string; models: string[] } | undefined

  const envKeys = [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_API_KEY',
    'MISTRAL_API_KEY',
    'DEEPSEEK_MODEL',
    'LLM_PROVIDER',
    'LLM_TOOL_ROOT',
  ]
  const base = (): string => `http://127.0.0.1:${core!.port}`

  beforeAll(async () => {
    // 两个假上游：**必须分开**，否则无法证明「按 provider 名路由到各自 baseUrl」
    openaiUp = await startFakeUpstream('OA')
    deepseekUp = await startFakeUpstream('DS')
    process.env.OPENAI_BASE_URL = openaiUp.baseUrl
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.DEEPSEEK_BASE_URL = deepseekUp.baseUrl
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    delete process.env.MISTRAL_API_KEY // 故意不配 → 该厂商不应注册
    process.env.DEEPSEEK_MODEL = 'deepseek-reasoner' // 顺带覆盖默认模型
    process.env.LLM_PROVIDER = 'openai'

    toolRoot = mkdtempSync(path.join(tmpdir(), 'ost-s1-tools-'))
    process.env.LLM_TOOL_ROOT = toolRoot

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-s1-smoke-'))
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
    openaiUp?.server.close()
    deepseekUp?.server.close()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    if (toolRoot) rmSync(toolRoot, { recursive: true, force: true })
  }, 30_000)

  it(
    '同一进程按 provider 名路由：deepseek 打 deepseek 上游、openai 打 openai 上游',
    async () => {
      const sse = await openSse(base(), '?topics=session.**,loop.**')
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
        await post(base(), 'session.create', { requestId: createId, title: '多实例' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createId),
          10_000,
          'session.create.result',
        )
        const sessionId = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === createId,
        )!.payload.sessionId as string

        const runOnce = async (requestId: string, payload: Record<string, unknown>): Promise<void> => {
          await post(base(), 'loop.run', { requestId, sessionId, text: 'hi', ...payload })
          await waitFor(
            () =>
              parseSseEvents(sse.text()).some(
                (e) => e.topic === 'loop.state.changed' && e.payload.requestId === requestId && e.payload.state === 'idle',
              ),
            20_000,
            `${requestId} 收尾 topics: ${parseSseEvents(sse.text()).map((e) => e.topic).join(',')}`,
          )
        }

        // 断言①：deepseek → 只到 deepseek 上游；且 DEEPSEEK_MODEL 覆盖生效
        openaiUp!.models.length = 0
        deepseekUp!.models.length = 0
        await runOnce(`run-ds-${Date.now()}`, { provider: 'deepseek' })
        expect(deepseekUp!.models, 'deepseek 请求没到 deepseek 上游').toEqual(['deepseek-reasoner'])
        expect(openaiUp!.models, 'deepseek 请求不该打到 openai 上游').toHaveLength(0)

        // 断言②：切回 openai → 只到 openai 上游
        openaiUp!.models.length = 0
        deepseekUp!.models.length = 0
        await runOnce(`run-oa-${Date.now()}`, { provider: 'openai', model: 'gpt-4o-mini' })
        expect(openaiUp!.models, 'openai 请求没到 openai 上游').toEqual(['gpt-4o-mini'])
        expect(deepseekUp!.models, 'openai 请求不该打到 deepseek 上游').toHaveLength(0)

        // 断言③：未配凭证的厂商不注册 → unsupported_provider，且不产生任何上游请求
        openaiUp!.models.length = 0
        deepseekUp!.models.length = 0
        const missId = `run-miss-${Date.now()}`
        await post(base(), 'loop.run', { requestId: missId, sessionId, text: 'hi', provider: 'mistral' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'loop.run.failed' && e.payload.requestId === missId),
          15_000,
          'loop.run.failed(unsupported_provider)',
        )
        const failed = parseSseEvents(sse.text()).find((e) => e.topic === 'loop.run.failed' && e.payload.requestId === missId)!
        expect((failed.payload.error as { code: string }).code).toBe('unsupported_provider')
        expect([...openaiUp!.models, ...deepseekUp!.models], '未注册的厂商不该打到任何上游').toHaveLength(0)
      } finally {
        sse.close()
      }
    },
    60_000,
  )
})
