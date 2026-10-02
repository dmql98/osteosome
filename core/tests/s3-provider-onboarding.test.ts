/**
 * S3 集成冒烟 · 设置窗「新增服务商」—— 真 Core + 真服务 + 假上游，**不设任何 *_API_KEY**。
 *
 * 对应开发计划的验收句：
 * > 「设置窗新增 deepseek 后，对话窗下拉出现 deepseek 且能选中；删掉凭证后消失」
 *
 * ## 与 S1 冒烟的分工
 *
 * S1 那份用 `process.env.DEEPSEEK_API_KEY` 证明「配了 env 就注册」。本份证明的是**另一条路**：
 * 用户在设置窗操作（存密钥 / 删密钥）→ provider **运行期**重算 → 下拉出现 / 消失。
 *
 * 这条不能靠 env 测，因为 env 改了要重启进程；而「不用重启就生效」正是 S3 的核心价值。
 * 顺带证明「存在性由配置决定」在**运行期**同样成立，不只是启动那一刻。
 *
 * ## 为什么能观察到这个变化
 *
 * `credential.saved` / `credential.deleted` 是总线事件，SSE 能收到；provider 收到后重算并发
 * `llm.provider.registered` / `llm.provider.unregistered`，主位据此增删路由。所以观察链是：
 *
 * ```
 * PUT /api/credentials ──► Core 凭证库 ──► credential.saved ──► provider 重算
 *                                                     └─► llm.provider.registered ──► 前端下拉
 * ```
 *
 * 断言一律用**行为**（指定它发问能不能打通 / 是不是 unsupported_provider），
 * 不用 `llm.provider.registered` 事件 —— 那类事件在服务启动瞬间就发完了，冒烟阶段开的 SSE 看不到。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type Core } from '../src/main'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 本文件要证明的那家（故意不在 env 里配） */
const VENDOR = 'deepseek'
/** 始终可用的那家（免凭证本地端点，作为对照组：它不该被上述操作影响） */
const LOCAL = 'ollama'

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

/** 假 openai 上游：只记模型名，回固定正文 */
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
        model = (JSON.parse(await readBody(req)) as { model?: string }).model ?? ''
      } catch {
        /* 留空 */
      }
      models.push(model)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (o: unknown): void => {
        res.write(`data: ${JSON.stringify(o)}\n\n`)
      }
      for (const c of [...tag]) send({ id: tag, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })
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

describe('S3 集成冒烟 · 设置窗新增 / 删除服务商（运行期生效）', () => {
  let core: Core | undefined
  let dataDir = ''
  let toolRoot = ''
  let up: { server: Server; baseUrl: string; models: string[] } | undefined
  let credentialId = ''

  const envKeys = [
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OLLAMA_BASE_URL',
    'LLM_PROVIDER',
    'LLM_TOOL_ROOT',
  ]
  const base = (): string => `http://127.0.0.1:${core!.port}`

  /** 发一轮，回 'ok' | 'unsupported_provider' —— 行为断言，不用注册事件 */
  async function probe(sse: { text: () => string }, sessionId: string, provider: string): Promise<string> {
    const requestId = `probe-${provider}-${Date.now()}`
    await post(base(), 'loop.run', { requestId, sessionId, text: 'hi', provider })
    await waitFor(
      () =>
        parseSseEvents(sse.text()).some(
          (e) =>
            (e.topic === 'loop.state.changed' && e.payload.requestId === requestId && e.payload.state === 'idle') ||
            (e.topic === 'loop.run.failed' && e.payload.requestId === requestId),
        ),
      20_000,
      `probe ${provider} 收尾 topics: ${parseSseEvents(sse.text()).map((e) => e.topic).join(',')}`,
    )
    const failed = parseSseEvents(sse.text()).find(
      (e) => e.topic === 'loop.run.failed' && e.payload.requestId === requestId,
    )
    if (failed) return (failed.payload.error as { code: string }).code
    return 'ok'
  }

  beforeAll(async () => {
    up = await startFakeUpstream('S3')
    // 端点用 env 覆盖指到假上游（这是 S1 提供的注入口）；**故意不配 DEEPSEEK_API_KEY**
    process.env.DEEPSEEK_BASE_URL = up.baseUrl
    process.env.OLLAMA_BASE_URL = up.baseUrl
    process.env.LLM_PROVIDER = 'openai'
    toolRoot = mkdtempSync(path.join(tmpdir(), 'ost-s3-tools-'))
    process.env.LLM_TOOL_ROOT = toolRoot

    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-s3-smoke-'))
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
    up?.server.close()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    if (toolRoot) rmSync(toolRoot, { recursive: true, force: true })
  }, 30_000)

  it(
    '存密钥 → 运行期注册（免重启）；删密钥 → 运行期注销',
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
        await post(base(), 'session.create', { requestId: createId, title: 'S3' })
        await waitFor(
          () => parseSseEvents(sse.text()).some((e) => e.topic === 'session.create.result' && e.payload.requestId === createId),
          10_000,
          'session.create.result',
        )
        const sessionId = parseSseEvents(sse.text()).find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === createId,
        )!.payload.sessionId as string

        // ① 起点：没配密钥 → 该厂商不注册（下拉里没有它），指定它发问得 unsupported_provider
        up!.models.length = 0
        expect(await probe(sse, sessionId, VENDOR)).toBe('unsupported_provider')
        expect(up!.models, '未注册的厂商不该打到上游').toHaveLength(0)

        // ② 免凭证的本地端点始终可用（对照组：它不受本次操作影响）
        expect(await probe(sse, sessionId, LOCAL)).toBe('ok')

        // ③ 在设置窗「存密钥」：PUT /api/credentials，provider 字段就是厂商 id
        const putRes = await fetch(`${base()}/api/credentials`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `${VENDOR} key`, provider: VENDOR, value: 'sk-user-entered' }),
        })
        expect(putRes.status).toBe(200)
        const saved = (await putRes.json()) as { credential?: { id?: string } }
        credentialId = saved.credential?.id ?? ''
        expect(credentialId, '存密钥没返回 id').toBeTruthy()

        // ④ **不重启任何进程**，该厂商立刻可用 —— 这就是 S3 的核心价值
        up!.models.length = 0
        expect(await probe(sse, sessionId, VENDOR)).toBe('ok')
        expect(up!.models, '新增后的请求应打到 deepseek 端点').toHaveLength(1)

        // ⑤ 删掉密钥 → 立刻从路由里消失
        const delRes = await fetch(`${base()}/api/credentials?id=${encodeURIComponent(credentialId)}`, {
          method: 'DELETE',
        })
        expect(delRes.status).toBe(200)
        up!.models.length = 0
        expect(await probe(sse, sessionId, VENDOR)).toBe('unsupported_provider')
        expect(up!.models, '注销后不该再打到上游').toHaveLength(0)

        // ⑥ 对照组仍然可用（注销只影响被删的那家）
        expect(await probe(sse, sessionId, LOCAL)).toBe('ok')
      } finally {
        sse.close()
      }
    },
    90_000,
  )
})
