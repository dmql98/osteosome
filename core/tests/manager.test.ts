import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../src/bus/bus'
import { ServiceManager } from '../src/service-manager/manager'

const SERVICE_ID = 'svc'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-service.mjs')

const BASE_ENV = {
  FAKE_SERVICE_ID: SERVICE_ID,
  FAKE_MANIFEST: '{"publishes":["hello.command.started"],"subscribes":[],"version":"1.0.0"}',
}

interface LifecycleEvent {
  topic: string
  payload: Record<string, unknown>
}

interface ManagerCtx {
  dir: string
  bus: Bus
  events: LifecycleEvent[]
  manager: ServiceManager
  cleanup: () => Promise<void>
}

function makeManager(options: { maxRestarts?: number; extraEnv?: Record<string, string> } = {}): ManagerCtx {
  const dir = mkdtempSync(path.join(tmpdir(), 'ost-manager-'))
  const svcDir = path.join(dir, SERVICE_ID)
  mkdirSync(svcDir, { recursive: true })
  writeFileSync(
    path.join(svcDir, 'service.json'),
    JSON.stringify({
      id: SERVICE_ID,
      version: '1.0.0',
      protocolVersion: '1.0.0',
      entry: 'node service.mjs',
      publishes: ['hello.command.started'],
      subscribes: [],
      healthCheck: { interval: 60, timeout: 100 },
    }),
  )
  copyFileSync(FIXTURE, path.join(svcDir, 'service.mjs'))

  const bus = new Bus()
  const events: LifecycleEvent[] = []
  bus.subscribe('service.**', (payload, topic) => {
    events.push({ topic, payload })
  })

  for (const [k, v] of Object.entries(options.extraEnv ?? {})) process.env[k] = v

  const manager = new ServiceManager({
    servicesDir: dir,
    dataDir: path.join(dir, 'data'),
    sessionId: 'test-session',
    bus,
    handshakeTimeoutMs: 800,
    stopGraceMs: 800,
    maxRestarts: options.maxRestarts ?? 2,
    backoffBaseMs: 50,
    consecutiveHealthFailures: 2,
  })
  const cleanup = async () => {
    await manager.stop().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, bus, events, manager, cleanup }
}

function cleanupEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FAKE_')) delete process.env[k]
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`)
}

describe('ServiceManager', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v
  })
  afterAll(cleanupEnv)
  afterEach(cleanupEnv)

  it(
    'spawns a service, handshakes, and publishes service.starting → service.ready',
    async () => {
      const ctx = makeManager()
      try {
        await ctx.manager.start()
        await waitFor(() => ctx.manager.status(SERVICE_ID) === 'ready')

        const info = ctx.manager.list()[0]
        expect(info.status).toBe('ready')
        expect(info.pid).toBeTypeOf('number')
        expect(ctx.events.map((e) => e.topic)).toEqual(
          expect.arrayContaining(['service.starting', 'service.ready']),
        )
        expect(ctx.events[0].topic).toBe('service.starting')
        expect(ctx.events[0].payload).toMatchObject({
          serviceId: SERVICE_ID,
          version: '1.0.0',
          source: 'core',
        })
      } finally {
        await ctx.cleanup()
      }
    },
    20_000,
  )

  it(
    'graceful stop publishes service.stopped',
    async () => {
      const ctx = makeManager()
      try {
        await ctx.manager.start()
        await waitFor(() => ctx.manager.status(SERVICE_ID) === 'ready')
        await ctx.manager.stop()
        await waitFor(() => ctx.events.some((e) => e.topic === 'service.stopped'))
        expect(ctx.manager.status(SERVICE_ID)).toBe('stopped')
      } finally {
        await ctx.cleanup()
      }
    },
    20_000,
  )

  it(
    'routes bus.publish from the service onto the Core bus',
    async () => {
      const ctx = makeManager({
        extraEnv: {
          FAKE_PUBLISH_TOPIC: 'hello.command.started',
          FAKE_PUBLISH_PAYLOAD: '{"requestId":"r1","text":"hi","ts":1,"source":"fake"}',
        },
      })
      try {
        await ctx.manager.start()
        let got: unknown
        ctx.bus.subscribe('hello.command.started', (p) => {
          got = p
        })
        await waitFor(() => got !== undefined)
        expect(got as Record<string, unknown>).toMatchObject({
          requestId: 'r1',
          text: 'hi',
          source: 'svc',
        })
      } finally {
        await ctx.cleanup()
      }
    },
    20_000,
  )

  it(
    'restarts a crashed service (service.restarting → ready) once',
    async () => {
      const marker = path.join(tmpdir(), `ost-crash-${Date.now()}.flag`)
      const ctx = makeManager({
        extraEnv: { FAKE_CRASH_ONCE: '1', FAKE_CRASH_MARKER: marker },
      })
      try {
        await ctx.manager.start()
        await waitFor(() => ctx.manager.status(SERVICE_ID) === 'ready')
        expect(ctx.events.some((e) => e.topic === 'service.restarting')).toBe(true)
        expect(ctx.manager.list()[0].restartCount).toBe(1)
      } finally {
        await ctx.cleanup()
      }
    },
    20_000,
  )

  it(
    'marks failed and refuses to restart past maxRestarts (protocol error path, 补强①)',
    async () => {
      const ctx = makeManager({ maxRestarts: 1, extraEnv: { FAKE_GARBAGE: '1' } })
      try {
        await ctx.manager.start()
        await waitFor(() => ctx.manager.status(SERVICE_ID) === 'failed', 15_000)
        expect(ctx.events.some((e) => e.topic === 'service.failed')).toBe(true)
        expect(ctx.events.some((e) => e.topic === 'service.restarting')).toBe(true)
        expect(ctx.manager.list()[0].restartCount).toBe(1)
      } finally {
        await ctx.cleanup()
      }
    },
    25_000,
  )

  it(
    'restarts on consecutive heartbeat timeouts, then fails past maxRestarts',
    async () => {
      const ctx = makeManager({ maxRestarts: 1, extraEnv: { FAKE_IGNORE_PING: '1' } })
      try {
        await ctx.manager.start()
        await waitFor(() => ctx.manager.status(SERVICE_ID) === 'failed', 15_000)
        expect(ctx.events.some((e) => e.topic === 'service.restarting')).toBe(true)
        expect(ctx.manager.list()[0].status).toBe('failed')
      } finally {
        await ctx.cleanup()
      }
    },
    25_000,
  )

  it(
    'handshake timeout kills and restarts through the budget',
    async () => {
      const ctx = makeManager({
        maxRestarts: 2,
        extraEnv: { FAKE_DELAY_INITIALIZE_MS: '2000' },
      })
      try {
        await ctx.manager.start()
        await waitFor(() => ctx.manager.status(SERVICE_ID) === 'failed', 20_000)
        const restarts = ctx.events.filter((e) => e.topic === 'service.restarting')
        expect(restarts.length).toBeGreaterThanOrEqual(1)
        expect(ctx.events.some((e) => e.topic === 'service.failed')).toBe(true)
      } finally {
        await ctx.cleanup()
      }
    },
    30_000,
  )

  it(
    'rejects a manifest with unknown inject at startup (fail fast)',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'ost-manager-inject-'))
      const aDir = path.join(dir, 'a')
      mkdirSync(aDir, { recursive: true })
      writeFileSync(
        path.join(aDir, 'service.json'),
        JSON.stringify({
          id: 'a',
          version: '1.0.0',
          protocolVersion: '1.0.0',
          entry: 'node service.mjs',
          inject: ['missing-svc'],
          publishes: [],
          subscribes: [],
        }),
      )
      const bus = new Bus()
      const manager = new ServiceManager({
        servicesDir: dir,
        dataDir: path.join(dir, 'data'),
        sessionId: 's',
        bus,
        handshakeTimeoutMs: 500,
      })
      try {
        await expect(manager.start()).rejects.toThrow(/unknown inject/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    10_000,
  )
})