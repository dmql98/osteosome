/**
 * e2e：Core 微内核 + 真实服务进程（起真 `services/`，跑真 dist）。
 *
 * 被测对象是 **Core**，不是某个业务服务：进程拉起 /health 汇报、命令投递 → 事件总线 →
 * 进程被 kill 后自动重启、service.stop / start / restart 三条运维命令、SSE 桥转发。
 *
 * 载体选 `session`（S2 起）：原先用示例服务 hello，删掉后换成真业务服务 —— 用真服务当
 * 载体比用假服务更强，命令往返（`session.create` → `session.create.result` + 领域事件
 * `session.created`）本来就是 Core 该保证的语义。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type Core } from '../src/main'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE_ARTIFACTS = [
  path.join(REPO_ROOT, 'shared', 'dist', 'index.js'),
  path.join(REPO_ROOT, 'sdk', 'ts', 'dist', 'index.js'),
  // P2：服务产物在**插件**的 dist/server 下（Core 只认产物），不再在服务自己的 dist/
  path.join(REPO_ROOT, 'plugins', 'chat-workbench', 'dist', 'server', 'session', 'index.js'),
]

/** e2e 载体：真服务 id（命令往返 + 进程运维都拿它当靶子） */
const VEHICLE = 'session'

interface HealthService {
  id: string
  status: string
  pid?: number
  restartCount: number
}

interface HealthBody {
  ok: boolean
  services: HealthService[]
}

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
    if (Date.now() >= deadline) throw new Error(`${label}: timeout after ${timeoutMs}ms`)
    await sleep(80)
  }
}

function ensureWorkspaceBuilt(): void {
  const missing = BASE_ARTIFACTS.filter((f) => !existsSync(f))
  if (missing.length === 0) return
  const res = spawnSync('pnpm', ['-r', 'run', 'build'], {
    cwd: REPO_ROOT,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  if (res.status !== 0) throw new Error(`workspace build failed (status=${String(res.status)})`)
  const still = BASE_ARTIFACTS.filter((f) => !existsSync(f))
  if (still.length > 0) throw new Error(`missing dist after build: ${still.join(', ')}`)
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

function parseSseEvents(text: string): SseEvent[] {
  const out: SseEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const parsed = JSON.parse(line.slice(6)) as SseEvent
      if (typeof parsed.topic === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        out.push(parsed)
      }
    } catch {
      /* partial frame still being written */
    }
  }
  return out
}

async function openSse(
  base: string,
  query = '',
): Promise<{ text: () => string; close: () => void }> {
  const controller = new AbortController()
  const res = await fetch(`${base}/events${query}`, { signal: controller.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')

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

  return {
    text: () => buf,
    close: () => controller.abort(),
  }
}

describe('e2e: core + session', () => {
  let core: Core | undefined
  let dataDir = ''
  let lifecycle: Array<{ topic: string; payload: Record<string, unknown> }> = []
  let firstPid: number | undefined

  const base = (): string => `http://127.0.0.1:${core!.port}`

  async function getVehicle(): Promise<HealthService | undefined> {
    try {
      const res = await fetch(`${base()}/health`)
      if (!res.ok) return undefined
      const body = (await res.json()) as HealthBody
      return body.services.find((s) => s.id === VEHICLE)
    } catch {
      return undefined
    }
  }

  async function waitForVehicle(
    predicate: (s: HealthService) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<HealthService> {
    let last: HealthService | undefined
    await waitFor(
      async () => {
        const h = await getVehicle()
        if (h) last = h
        return h !== undefined && predicate(h)
      },
      timeoutMs,
      label,
    )
    if (!last) throw new Error(`${label}: no ${VEHICLE} entry in /health`)
    return last
  }

  /**
   * 命令往返：POST `/api/command` → 服务处理 → SSE 收到 `session.create.result`。
   * 顺带把领域事件 `session.created` 也带回来（Core 必须把两类事件都桥给前端）。
   */
  async function postUntilResult(
    sse: { text: () => string },
    requestId: string,
    title: string,
    timeoutMs = 15_000,
  ): Promise<SseEvent[]> {
    const res = await fetch(`${base()}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'session.create', payload: { requestId, title } }),
    })
    expect(res.status).toBe(202)
    await res.text().catch(() => '')
    await waitFor(() => {
      return parseSseEvents(sse.text()).some(
        (e) => e.topic === 'session.create.result' && e.payload.requestId === requestId,
      )
    }, timeoutMs, `command '${requestId}' result`)
    return parseSseEvents(sse.text())
  }

  beforeAll(async () => {
    ensureWorkspaceBuilt()
    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-e2e-'))
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
    lifecycle = []
    core.bus.subscribe('service.**', (payload, topic) => {
      lifecycle.push({ topic, payload })
    })
  }, 120_000)

  afterAll(async () => {
    await core?.stop().catch(() => undefined)
    core = undefined
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  }, 30_000)

  it(
    'spawns session and reports ready via /health',
    async () => {
      const svc = await waitForVehicle((s) => s.status === 'ready', 30_000, 'session ready')
      expect(svc.id).toBe('session')
      expect(svc.pid).toBeTypeOf('number')
      expect(svc.restartCount).toBe(0)
      firstPid = svc.pid
    },
    40_000,
  )

  it(
    'POST session.create → SSE receives result + domain event, both sourced from session',
    async () => {
      // `session.**` 而不是 `session.*`：命令回执是两层（session.create.result），
      // 单层通配只吃到 session.create / session.created，回执永远等不到
      const sse = await openSse(base(), '?topics=session.**')
      try {
        const requestId = `e2e-${Date.now()}`
        const events = await postUntilResult(sse, requestId, 'ping-e2e')
        const result = events.find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === requestId,
        )
        const created = events.find(
          (e) => e.topic === 'session.created' && e.payload.title === 'ping-e2e',
        )
        expect(result, `result missing; sse=${sse.text().slice(0, 500)}`).toBeDefined()
        expect(created, `session.created missing; sse=${sse.text().slice(0, 500)}`).toBeDefined()
        expect(result!.payload).toMatchObject({ requestId, title: 'ping-e2e' })
        expect(typeof result!.payload.sessionId).toBe('string')
        // 领域事件与命令回执指向同一个会话：证明 bus 与 bridge 都没串味
        expect(created!.payload.sessionId).toBe(result!.payload.sessionId)
        // source 由 SDK 注入，标明事件来自哪个服务进程
        expect(result!.payload.source).toBe('session')
      } finally {
        sse.close()
      }
    },
    30_000,
  )

  it(
    'kills session → auto-restarts → command works again',
    async () => {
      const before = await getVehicle()
      expect(before?.pid).toBe(firstPid)
      expect(before?.pid, 'session pid missing').toBeTypeOf('number')
      killPid(before!.pid!)

      const restarted = await waitForVehicle(
        (s) =>
          s.status === 'ready' &&
          s.restartCount >= 1 &&
          s.pid !== firstPid,
        30_000,
        'session restart',
      )
      expect(restarted.pid).not.toBe(firstPid)
      expect(restarted.restartCount).toBe(1)
      expect(lifecycle.some((e) => e.topic === 'service.restarting')).toBe(true)

      const sse = await openSse(base(), '?topics=session.**')
      try {
        const requestId = `e2e-rs-${Date.now()}`
        const events = await postUntilResult(sse, requestId, 'after-restart')
        const result = events.find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === requestId,
        )
        expect(result).toBeDefined()
        expect(result!.payload).toMatchObject({ requestId, title: 'after-restart' })
      } finally {
        sse.close()
      }
    },
    60_000,
  )

  it(
    'service.stop command → session stopped → service.start brings it back',
    async () => {
      // 停用
      const stopRes = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.stop', payload: { serviceId: VEHICLE } }),
      })
      expect(stopRes.status).toBe(202)
      await waitForVehicle(
        (s) => s.status === 'stopped',
        15_000,
        'session stopped via command',
      )

      // 停用后命令不再执行：POST 仍是 202（命令被接受），但服务不再处理
      // 用 /health 确认 status=stopped 即可（上一步已断言）

      // 启用
      const startRes = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.start', payload: { serviceId: VEHICLE } }),
      })
      expect(startRes.status).toBe(202)
      await waitForVehicle(
        (s) => s.status === 'ready',
        20_000,
        'session started via command',
      )

      // 命令可用性恢复
      const sse = await openSse(base(), '?topics=session.**')
      try {
        const requestId = `e2e-svc-${Date.now()}`
        const events = await postUntilResult(sse, requestId, 'after-control')
        const result = events.find(
          (e) => e.topic === 'session.create.result' && e.payload.requestId === requestId,
        )
        expect(result).toBeDefined()
        expect(result!.payload).toMatchObject({ requestId, title: 'after-control' })
      } finally {
        sse.close()
      }
    },
    60_000,
  )

  it(
    'service.restart command → pid changes → ready again',
    async () => {
      const before = await getVehicle()
      expect(before?.pid, 'session pid missing before restart').toBeTypeOf('number')

      const res = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.restart', payload: { serviceId: VEHICLE } }),
      })
      expect(res.status).toBe(202)

      await waitForVehicle(
        (s) => s.status === 'ready' && s.pid !== before?.pid,
        20_000,
        'session restarted via command',
      )
      expect(lifecycle.some((e) => e.topic === 'service.restarting')).toBe(true)
    },
    40_000,
  )

  it(
    'service.stop with unknown serviceId → 400 with error',
    async () => {
      const res = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.stop', payload: { serviceId: 'nope' } }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toContain('unknown service')
    },
    20_000,
  )
})
