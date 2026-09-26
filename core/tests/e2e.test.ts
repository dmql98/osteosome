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
  path.join(REPO_ROOT, 'services', 'hello', 'dist', 'index.js'),
]

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

describe('e2e: core + hello', () => {
  let core: Core | undefined
  let dataDir = ''
  let lifecycle: Array<{ topic: string; payload: Record<string, unknown> }> = []
  let firstPid: number | undefined

  const base = (): string => `http://127.0.0.1:${core!.port}`

  async function getHello(): Promise<HealthService | undefined> {
    try {
      const res = await fetch(`${base()}/health`)
      if (!res.ok) return undefined
      const body = (await res.json()) as HealthBody
      return body.services.find((s) => s.id === 'hello')
    } catch {
      return undefined
    }
  }

  async function waitForHello(
    predicate: (s: HealthService) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<HealthService> {
    let last: HealthService | undefined
    await waitFor(
      async () => {
        const h = await getHello()
        if (h) last = h
        return h !== undefined && predicate(h)
      },
      timeoutMs,
      label,
    )
    if (!last) throw new Error(`${label}: no hello entry in /health`)
    return last
  }

  async function postUntilExecuted(
    sse: { text: () => string },
    requestId: string,
    text: string,
    timeoutMs = 15_000,
  ): Promise<SseEvent[]> {
    const res = await fetch(`${base()}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'hello.command', payload: { requestId, text } }),
    })
    expect(res.status).toBe(202)
    await res.text().catch(() => '')
    await waitFor(() => {
      return parseSseEvents(sse.text()).some(
        (e) => e.topic === 'hello.command.executed' && e.payload.requestId === requestId,
      )
    }, timeoutMs, `command '${requestId}' executed`)
    return parseSseEvents(sse.text())
  }

  beforeAll(async () => {
    ensureWorkspaceBuilt()
    dataDir = mkdtempSync(path.join(tmpdir(), 'ost-e2e-'))
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
    'spawns hello and reports ready via /health',
    async () => {
      const hello = await waitForHello((s) => s.status === 'ready', 30_000, 'hello ready')
      expect(hello.id).toBe('hello')
      expect(hello.pid).toBeTypeOf('number')
      expect(hello.restartCount).toBe(0)
      firstPid = hello.pid
    },
    40_000,
  )

  it(
    'POST hello.command → SSE receives started/executed with source hello',
    async () => {
      const sse = await openSse(base(), '?topics=hello.command.*')
      try {
        const requestId = `e2e-${Date.now()}`
        const events = await postUntilExecuted(sse, requestId, 'ping-e2e')
        const started = events.find(
          (e) => e.topic === 'hello.command.started' && e.payload.requestId === requestId,
        )
        const executed = events.find(
          (e) => e.topic === 'hello.command.executed' && e.payload.requestId === requestId,
        )
        expect(started, `started missing; sse=${sse.text().slice(0, 500)}`).toBeDefined()
        expect(executed, `executed missing; sse=${sse.text().slice(0, 500)}`).toBeDefined()
        expect(started!.payload).toMatchObject({
          requestId,
          text: 'ping-e2e',
          source: 'hello',
        })
        expect(typeof started!.payload.ts).toBe('number')
        expect(executed!.payload).toMatchObject({
          requestId,
          echo: 'ping-e2e',
          source: 'hello',
        })
        expect(typeof executed!.payload.ts).toBe('number')
      } finally {
        sse.close()
      }
    },
    30_000,
  )

  it(
    'kills hello → auto-restarts → command works again',
    async () => {
      const before = await getHello()
      expect(before?.pid).toBe(firstPid)
      expect(before?.pid, 'hello pid missing').toBeTypeOf('number')
      killPid(before!.pid!)

      const restarted = await waitForHello(
        (s) =>
          s.status === 'ready' &&
          s.restartCount >= 1 &&
          s.pid !== firstPid,
        30_000,
        'hello restart',
      )
      expect(restarted.pid).not.toBe(firstPid)
      expect(restarted.restartCount).toBe(1)
      expect(lifecycle.some((e) => e.topic === 'service.restarting')).toBe(true)

      const sse = await openSse(base(), '?topics=hello.command.*')
      try {
        const requestId = `e2e-rs-${Date.now()}`
        const events = await postUntilExecuted(sse, requestId, 'after-restart')
        const executed = events.find(
          (e) => e.topic === 'hello.command.executed' && e.payload.requestId === requestId,
        )
        expect(executed).toBeDefined()
        expect(executed!.payload).toMatchObject({
          requestId,
          echo: 'after-restart',
          source: 'hello',
        })
      } finally {
        sse.close()
      }
    },
    60_000,
  )

  it(
    'service.stop command → hello stopped → service.start brings it back',
    async () => {
      // 停用
      const stopRes = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.stop', payload: { serviceId: 'hello' } }),
      })
      expect(stopRes.status).toBe(202)
      await waitForHello(
        (s) => s.status === 'stopped',
        15_000,
        'hello stopped via command',
      )

      // 停用后命令不再执行：POST 仍是 202（命令被接受），但 hello 不再发布事件
      // 用 /health 确认 status=stopped 即可（上一步已断言）

      // 启用
      const startRes = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.start', payload: { serviceId: 'hello' } }),
      })
      expect(startRes.status).toBe(202)
      await waitForHello(
        (s) => s.status === 'ready',
        20_000,
        'hello started via command',
      )

      // 命令可用性恢复
      const sse = await openSse(base(), '?topics=hello.command.*')
      try {
        const requestId = `e2e-svc-${Date.now()}`
        const events = await postUntilExecuted(sse, requestId, 'after-control')
        const executed = events.find(
          (e) => e.topic === 'hello.command.executed' && e.payload.requestId === requestId,
        )
        expect(executed).toBeDefined()
        expect(executed!.payload).toMatchObject({
          requestId,
          echo: 'after-control',
          source: 'hello',
        })
      } finally {
        sse.close()
      }
    },
    60_000,
  )

  it(
    'service.restart command → pid changes → ready again',
    async () => {
      const before = await getHello()
      expect(before?.pid, 'hello pid missing before restart').toBeTypeOf('number')

      const res = await fetch(`${base()}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'service.restart', payload: { serviceId: 'hello' } }),
      })
      expect(res.status).toBe(202)

      await waitForHello(
        (s) => s.status === 'ready' && s.pid !== before?.pid,
        20_000,
        'hello restarted via command',
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
