import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { RpcTimeoutError, StreamTransport, FrameDecoder, encodeFrame, type JsonRpcMessage } from '../src/transport'
import { Service, type ServiceOptions } from '../src/service'
import { logger } from '../src/logger'

logger.setLevel('error')

const TEST_MANIFEST = {
  id: 'hello',
  version: '1.0.0',
  protocolVersion: '1.0.0',
  publishes: ['hello.command.started'],
  subscribes: ['hello.command'],
}

const TEST_RESULT = { sessionId: 'sess-test', heartbeatInterval: 100, dataDir: '/tmp/ost-data' }

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 伪造 Core：分帧 JSON-RPC 对端，应答 initialize / bus.*，可主动推 ping/event/shutdown */
class FakeCore {
  readonly received: JsonRpcMessage[] = []
  readonly transport: StreamTransport
  private readonly decoder = new FrameDecoder()
  private readonly toService: PassThrough
  private readonly fromService: PassThrough
  private dropInitialize: number
  private readonly badInitialize: boolean

  constructor(opts: { dropInitialize?: number; badInitialize?: boolean } = {}) {
    this.dropInitialize = opts.dropInitialize ?? 0
    this.badInitialize = opts.badInitialize ?? false
    this.toService = new PassThrough()
    this.fromService = new PassThrough()
    this.transport = new StreamTransport(this.toService, this.fromService)
    this.fromService.on('data', (chunk: Buffer) => {
      for (const raw of this.decoder.push(chunk)) {
        const msg = JSON.parse(raw) as JsonRpcMessage
        this.received.push(msg)
        this.handle(msg)
      }
    })
  }

  send(msg: unknown): void {
    this.toService.write(encodeFrame(msg))
  }

  sendPing(): void {
    this.send({ jsonrpc: '2.0', method: 'health.ping' })
  }

  sendEvent(topic: string, payload: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method: 'bus.event', params: { topic, payload } })
  }

  sendShutdown(): void {
    this.send({ jsonrpc: '2.0', method: 'shutdown' })
  }

  requestsOf(method: string): JsonRpcMessage[] {
    return this.received.filter((m) => m.method === method && m.id !== undefined)
  }

  notificationsOf(method: string): JsonRpcMessage[] {
    return this.received.filter((m) => m.method === method && m.id === undefined)
  }

  private handle(msg: JsonRpcMessage): void {
    if (msg.method === 'initialize' && msg.id !== undefined) {
      if (this.dropInitialize > 0) {
        this.dropInitialize--
        return
      }
      const result = this.badInitialize ? { bogus: true } : TEST_RESULT
      this.send({ jsonrpc: '2.0', id: msg.id, result })
      return
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    }
  }
}

function createService(fake: FakeCore, overrides: Partial<ServiceOptions> = {}): Service {
  return new Service({
    id: 'hello',
    version: '1.0.0',
    manifest: TEST_MANIFEST,
    transport: fake.transport,
    handleSignals: false,
    ...overrides,
  })
}

describe('handshake', () => {
  it('initialize (with id) → initialized; wires dataDir/sessionId/heartbeatInterval', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    const result = await svc.start()
    expect(result).toEqual(TEST_RESULT)
    expect(svc.dataDir).toBe('/tmp/ost-data')
    expect(svc.sessionId).toBe('sess-test')
    expect(svc.heartbeatInterval).toBe(100)

    const init = fake.requestsOf('initialize')
    expect(init).toHaveLength(1)
    expect(init[0].id).toBeDefined()
    expect(init[0].params).toMatchObject({ serviceId: 'hello', protocolVersion: '1.0.0' })

    await until(() => fake.notificationsOf('initialized').length === 1)
    await svc.stop()
  })

  it('retries initialize after timeout', async () => {
    const fake = new FakeCore({ dropInitialize: 1 })
    const svc = createService(fake, { handshake: { timeoutMs: 30, retries: 1, retryDelayMs: 5 } })
    await svc.start()
    expect(fake.requestsOf('initialize')).toHaveLength(2)
    expect(svc.dataDir).toBe('/tmp/ost-data')
    await svc.stop()
  })

  it('fails when Core never responds', async () => {
    const fake = new FakeCore({ dropInitialize: 99 })
    const svc = createService(fake, { handshake: { timeoutMs: 20, retries: 0 } })
    await expect(svc.start()).rejects.toBeInstanceOf(RpcTimeoutError)
  })

  it('rejects invalid InitializeResult without retry', async () => {
    const fake = new FakeCore({ badInitialize: true })
    const svc = createService(fake, { handshake: { timeoutMs: 50, retries: 2, retryDelayMs: 5 } })
    await expect(svc.start()).rejects.toThrow(/invalid InitializeResult/)
    expect(fake.requestsOf('initialize')).toHaveLength(1)
  })
})

describe('heartbeat', () => {
  it('answers health.ping with health.pong (notification, no id)', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    fake.sendPing()
    await until(() => fake.notificationsOf('health.pong').length >= 1)
    await svc.stop()
  })

  it('heartbeat stops after stop()', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    await svc.stop()
    fake.sendPing()
    await sleep(30)
    expect(fake.notificationsOf('health.pong')).toHaveLength(0)
  })
})

describe('subscriptions & events', () => {
  it('first subscribe sends bus.subscribe (with id); bus.event dispatches payload+topic', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const calls: Array<{ payload: unknown; topic: string }> = []
    svc.subscribe('hello.command', (payload, topic) => {
      calls.push({ payload, topic })
    })
    await until(() => fake.requestsOf('bus.subscribe').length === 1)
    const sub = fake.requestsOf('bus.subscribe')[0]
    expect(sub.id).toBeDefined()
    expect(sub.params).toEqual({ topic: 'hello.command' })

    fake.sendEvent('hello.command', { requestId: 'r1', text: 'hi' })
    await until(() => calls.length === 1)
    expect(calls[0]).toEqual({ payload: { requestId: 'r1', text: 'hi' }, topic: 'hello.command' })
    await svc.stop()
  })

  it('local wildcard matching: * one segment, ** multi-segment', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const single: string[] = []
    const multi: string[] = []
    svc.subscribe('hello.*', (_p, t) => single.push(t))
    svc.subscribe('hello.**', (_p, t) => multi.push(t))
    await until(() => fake.requestsOf('bus.subscribe').length === 2)

    fake.sendEvent('hello.command.started', {})
    await until(() => multi.length === 1)
    expect(single).toHaveLength(0)

    fake.sendEvent('hello.command', {})
    await until(() => single.length === 1 && multi.length === 2)
    expect(single).toEqual(['hello.command'])
    await svc.stop()
  })

  it('disposer detaches handler and sends bus.unsubscribe when last handler removed', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const calls: unknown[] = []
    const h = () => calls.push(1)
    const dispose = svc.subscribe('hello.command', h)
    await until(() => fake.requestsOf('bus.subscribe').length === 1)

    dispose()
    await until(() => fake.requestsOf('bus.unsubscribe').length === 1)
    expect(fake.requestsOf('bus.unsubscribe')[0].params).toEqual({ topic: 'hello.command' })

    fake.sendEvent('hello.command', {})
    await sleep(30)
    expect(calls).toHaveLength(0)
    await svc.stop()
  })

  it('shared topic: unsubscribe only after last handler disposed', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const d1 = svc.subscribe('hello.command', () => {})
    svc.subscribe('hello.command', () => {})
    await until(() => fake.requestsOf('bus.subscribe').length === 1)
    d1()
    await sleep(20)
    expect(fake.requestsOf('bus.unsubscribe')).toHaveLength(0)
    await svc.stop()
  })

  it('subscriptions registered before start() are flushed after handshake', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    svc.subscribe('hello.command', () => {})
    await svc.start()
    await until(() =>
      fake.requestsOf('bus.subscribe').some((m) => (m.params as { topic: string }).topic === 'hello.command'),
    )
    await svc.stop()
  })

  it('handler errors are isolated; other handlers still run', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    let second = 0
    svc.subscribe('hello.command', () => {
      throw new Error('boom')
    })
    svc.subscribe('hello.command', () => {
      second++
    })
    fake.sendEvent('hello.command', {})
    await until(() => second === 1)
    await svc.stop()
  })

  it('async handler rejection does not break dispatch', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    let second = 0
    svc.subscribe('hello.command', async () => {
      await sleep(1)
      throw new Error('async-boom')
    })
    svc.subscribe('hello.command', () => {
      second++
    })
    fake.sendEvent('hello.command', {})
    await until(() => second === 1)
    await svc.stop()
  })
})

describe('publish', () => {
  it('publish sends bus.publish as a request (with id)', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    svc.publish('hello.command.started', { requestId: 'r1', text: 'x' })
    await until(() => fake.requestsOf('bus.publish').length === 1)
    const pub = fake.requestsOf('bus.publish')[0]
    expect(pub.id).toBeDefined()
    expect(pub.params).toEqual({
      topic: 'hello.command.started',
      payload: { requestId: 'r1', text: 'x' },
    })
    await svc.stop()
  })

  it('service.bus.publish alias works identically', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    svc.bus.publish('hello.command.started', { requestId: 'r2', text: 'y' })
    await until(() => fake.requestsOf('bus.publish').length === 1)
    expect(fake.requestsOf('bus.publish')[0].params).toMatchObject({
      payload: { requestId: 'r2' },
    })
    await svc.stop()
  })

  it('publish before start is dropped (nothing on the wire)', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    svc.publish('hello.command.started', {})
    await sleep(20)
    expect(fake.received).toHaveLength(0)
  })
})

describe('graceful shutdown', () => {
  it('stop({notifyShutdown:true}): unsubscribe then shutdown notification (no id), in order', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    svc.subscribe('hello.command', () => {})
    await until(() => fake.requestsOf('bus.subscribe').length === 1)

    await svc.stop({ notifyShutdown: true })
    await until(() => fake.notificationsOf('shutdown').length === 1)

    const unsubIdx = fake.received.findIndex((m) => m.method === 'bus.unsubscribe')
    const shutIdx = fake.received.findIndex((m) => m.method === 'shutdown')
    expect(unsubIdx).toBeGreaterThanOrEqual(0)
    expect(shutIdx).toBeGreaterThan(unsubIdx)
    expect(fake.received[shutIdx].id).toBeUndefined()
  })

  it('remote shutdown → graceful stop → exit(0)', async () => {
    const fake = new FakeCore()
    const exits: number[] = []
    const svc = createService(fake, { exit: (c) => exits.push(c) })
    await svc.start()
    svc.subscribe('hello.command', () => {})
    await until(() => fake.requestsOf('bus.subscribe').length === 1)

    fake.sendShutdown()
    await until(() => exits.length === 1)
    expect(exits[0]).toBe(0)
    await until(() => fake.requestsOf('bus.unsubscribe').length === 1)
  })

  it('stop waits for in-flight async handlers before resolving', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    let started = false
    let finished = false
    svc.subscribe('hello.command', async () => {
      started = true
      await sleep(50)
      finished = true
    })
    fake.sendEvent('hello.command', {})
    await until(() => started)
    await svc.stop()
    expect(finished).toBe(true)
  })

  it('bus.event after stop is not dispatched', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const calls: unknown[] = []
    svc.subscribe('hello.command', () => calls.push(1))
    await svc.stop()
    fake.sendEvent('hello.command', {})
    await sleep(30)
    expect(calls).toHaveLength(0)
  })

  it('installs SIGTERM/SIGINT handlers on start and removes them on stop', async () => {
    const fake = new FakeCore()
    const beforeTerm = process.listenerCount('SIGTERM')
    const beforeInt = process.listenerCount('SIGINT')
    const svc = createService(fake, { handleSignals: true, exit: () => {} })
    await svc.start()
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1)
    await svc.stop()
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt)
  })

  it('concurrent stop() calls share one shutdown', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const [a, b] = await Promise.all([svc.stop(), svc.stop()])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(fake.notificationsOf('shutdown')).toHaveLength(0)
  })
})

describe('lifecycle guards', () => {
  it('start() twice throws', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    await expect(svc.start()).rejects.toThrow('already started')
    await svc.stop()
  })
})
