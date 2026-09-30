/**
 * credentials 客户端单测（P2 WS-2）—— 用 FakeCore 起真实 Service + attachCredentialClient，
 * 验证 credentials.resolve 命令发出与 credentials.resolved 事件配对。
 */
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { StreamTransport, FrameDecoder, encodeFrame, type JsonRpcMessage } from '../src/transport'
import { Service, type ServiceOptions } from '../src/service'
import { attachCredentialClient, CredentialClientError } from '../src/credentials'
import { logger } from '../src/logger'

logger.setLevel('error')

const TEST_MANIFEST = {
  id: 'llm-provider-openrouter',
  version: '1.0.0',
  protocolVersion: '1.0.0',
  publishes: ['llm.provider.registered', 'llm.provider.chunk', 'llm.provider.unregistered'],
  subscribes: ['llm.provider.request', 'llm.provider.cancel', 'credentials.resolved'],
}

const TEST_RESULT = { sessionId: 'sess-creds', heartbeatInterval: 100, dataDir: '/tmp/ost-data' }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 伪造 Core：应答 initialize + bus.*，可主动推 bus.event（credentials.resolved） */
class FakeCore {
  readonly received: JsonRpcMessage[] = []
  readonly transport: StreamTransport
  private readonly toService: PassThrough
  private readonly fromService: PassThrough
  private readonly decoder = new FrameDecoder()

  constructor() {
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

  /** 模拟 credentials 能力位：收到 credentials.resolve 后回 credentials.resolved 事件 */
  autoResolve(payload: (p: Record<string, unknown>) => Record<string, unknown>): void {
    const h = (msg: JsonRpcMessage): void => {
      if (msg.method === 'bus.publish') {
        const params = msg.params as { topic?: string; payload?: Record<string, unknown> } | undefined
        if (params?.topic === 'credentials.resolve') {
          const p = params.payload ?? {}
          const requestId = typeof p.requestId === 'string' ? p.requestId : 'x'
          this.send({
            jsonrpc: '2.0',
            method: 'bus.event',
            params: { topic: 'credentials.resolved', payload: payload({ ...p, requestId }) },
          })
        }
      }
    }
    this.fromService.on('data', () => {
      // 每次有帧进来再扫一遍 received（新帧已入列）
      for (const m of this.received) h(m)
    })
  }

  requestsOf(method: string): JsonRpcMessage[] {
    return this.received.filter((m) => m.method === method && m.id !== undefined)
  }

  publishesOf(topic: string): Record<string, unknown>[] {
    return this.received
      .filter((m) => m.method === 'bus.publish')
      .map((m) => m.params as { topic?: string; payload?: Record<string, unknown> })
      .filter((p) => p?.topic === topic)
      .map((p) => p.payload ?? {})
  }

  private handle(msg: JsonRpcMessage): void {
    if (msg.method === 'initialize' && msg.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: msg.id, result: TEST_RESULT })
      return
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    }
  }
}

function createService(fake: FakeCore, overrides: Partial<ServiceOptions> = {}): Service {
  return new Service({
    id: 'llm-provider-openrouter',
    version: '1.0.0',
    manifest: TEST_MANIFEST,
    transport: fake.transport,
    handleSignals: false,
    ...overrides,
  })
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('attachCredentialClient', () => {
  it('resolve 发送 credentials.resolve 命令并配对 credentials.resolved 返回 apiKey', async () => {
    const fake = new FakeCore()
    fake.autoResolve((p) => ({ requestId: p.requestId, apiKey: 'sk-abc' }))
    const svc = createService(fake)
    await svc.start()
    const client = attachCredentialClient(svc)

    const result = await client.resolve('env:OPENROUTER_API_KEY', 'req-1')
    expect(result).toEqual({ apiKey: 'sk-abc' })

    const publishes = fake.publishesOf('credentials.resolve')
    expect(publishes).toEqual([{ requestId: 'req-1', ref: 'env:OPENROUTER_API_KEY' }])
    await svc.stop()
  })

  it('credentials.resolved 带 error → reject（不 resolve apiKey）', async () => {
    const fake = new FakeCore()
    fake.autoResolve((p) => ({ requestId: p.requestId, error: { code: 'missing_credential', message: 'env:KEY not set' } }))
    const svc = createService(fake)
    await svc.start()
    const client = attachCredentialClient(svc)

    await expect(client.resolve('env:MISSING', 'req-2')).rejects.toMatchObject({
      name: 'CredentialClientError',
      reason: 'closed',
      error: { code: 'missing_credential', message: 'env:KEY not set' },
    })
    await svc.stop()
  })

  it('在途解析未完成时并发调用 → 立即 reject concurrent（不串配）', async () => {
    const fake = new FakeCore()
    // 不回 resolved，模拟慢响应
    const svc = createService(fake)
    await svc.start()
    const client = attachCredentialClient(svc, { timeoutMs: 200 })

    const first = client.resolve('env:A', 'req-1')
    const second = client.resolve('env:B', 'req-2')
    await expect(second).rejects.toMatchObject({ name: 'CredentialClientError', reason: 'concurrent' })
    // 首个仍在途；dispose 时清理
    client.dispose()
    await expect(first).rejects.toMatchObject({ name: 'CredentialClientError' })
    await svc.stop()
  })

  it('超时无 resolved → reject timeout', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const client = attachCredentialClient(svc, { timeoutMs: 60 })
    await expect(client.resolve('env:A', 'req-t')).rejects.toMatchObject({
      name: 'CredentialClientError',
      reason: 'timeout',
    })
    await svc.stop()
  })

  it('dispose 后 resolve → 立即 reject closed', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const client = attachCredentialClient(svc)
    client.dispose()
    await expect(client.resolve('env:A', 'req-d')).rejects.toMatchObject({
      name: 'CredentialClientError',
      reason: 'closed',
    })
    await svc.stop()
  })

  it('resolve 带非法 ref → reject invalid ref', async () => {
    const fake = new FakeCore()
    const svc = createService(fake)
    await svc.start()
    const client = attachCredentialClient(svc)
    await expect(client.resolve('', 'req-i')).rejects.toMatchObject({
      name: 'CredentialClientError',
      reason: 'closed',
    })
    await svc.stop()
  })
})
