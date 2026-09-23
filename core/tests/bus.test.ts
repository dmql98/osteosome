import { describe, expect, it } from 'vitest'
import { Bus } from '../src/bus/bus'
import { MemoryAdapter } from '../src/bus/persistence'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

type Handler = (payload: Record<string, unknown>) => void

describe('bus', () => {
  it('publish returns synchronously but delivers asynchronously (microtask)', async () => {
    const bus = new Bus()
    const calls: string[] = []
    bus.subscribe('t.a', () => calls.push('x'))
    bus.publish('t.a', {})
    expect(calls).toHaveLength(0)
    await flushMicrotasks()
    expect(calls).toHaveLength(1)
  })

  it('isolates handler errors — a throwing subscriber does not stop others', async () => {
    const bus = new Bus()
    const calls: string[] = []
    bus.subscribe('t.a', () => {
      throw new Error('boom')
    })
    bus.subscribe('t.a', () => calls.push('ok'))
    bus.publish('t.a', {})
    await flushMicrotasks()
    expect(calls).toEqual(['ok'])
  })

  it('isolates async handler errors', async () => {
    const bus = new Bus()
    const calls: string[] = []
    bus.subscribe('t.a', async () => {
      throw new Error('async boom')
    })
    bus.subscribe('t.a', () => calls.push('ok'))
    bus.publish('t.a', {})
    await flushMicrotasks()
    await flushMicrotasks()
    expect(calls).toEqual(['ok'])
  })

  it('disposer rolls back subscription', async () => {
    const bus = new Bus()
    const calls: string[] = []
    const dispose = bus.subscribe('t.a', () => calls.push('x'))
    bus.publish('t.a', {})
    await flushMicrotasks()
    dispose()
    bus.publish('t.a', {})
    await flushMicrotasks()
    expect(calls).toEqual(['x'])
  })

  it('runs higher priority subscribers first', async () => {
    const bus = new Bus()
    const order: number[] = []
    bus.subscribe('t.a', () => order.push(1), { priority: 1 })
    bus.subscribe('t.a', () => order.push(2), { priority: 10 })
    bus.subscribe('t.a', () => order.push(3), { priority: 5 })
    bus.publish('t.a', {})
    await flushMicrotasks()
    expect(order).toEqual([2, 3, 1])
  })

  it('once fires exactly once', async () => {
    const bus = new Bus()
    let n = 0
    bus.subscribe('t.a', () => n++, { once: true })
    bus.publish('t.a', {})
    bus.publish('t.a', {})
    await flushMicrotasks()
    expect(n).toBe(1)
  })

  it('filter skips non-matching payloads', async () => {
    const bus = new Bus()
    const got: Array<Record<string, unknown>> = []
    bus.subscribe('t.a', (p) => got.push(p), { filter: (p) => p.kind === 'wanted' })
    bus.publish('t.a', { kind: 'unwanted' })
    bus.publish('t.a', { kind: 'wanted' })
    await flushMicrotasks()
    expect(got).toHaveLength(1)
    expect(got[0].kind).toBe('wanted')
  })

  it('backpressure drops the oldest when queue overflows and counts stats.dropped', async () => {
    const bus = new Bus({ maxQueueSize: 3 })
    const received: string[] = []
    bus.subscribe('*', (p) => received.push(String(p.n)))
    for (let i = 1; i <= 6; i++) {
      bus.publish('t.a', { n: i })
    }
    const stats = bus.statsSnapshot()
    expect(stats.published).toBe(6)
    expect(stats.dropped).toBe(3)
    await flushMicrotasks()
    expect(received).toHaveLength(3)
  })

  it('wildcard and exact topics share delivery, delivering via matched patterns', async () => {
    const bus = new Bus()
    const got: string[] = []
    bus.subscribe('service.**', () => got.push('wild'))
    bus.subscribe('service.ready', () => got.push('exact'))
    bus.publish('service.ready', { ts: Date.now(), source: 'test', serviceId: 'x', version: '1' })
    await flushMicrotasks()
    expect(got.sort()).toEqual(['exact', 'wild'])
  })

  it('normalizes payload with ts/source defaults', async () => {
    const bus = new Bus()
    const got: Array<Record<string, unknown>> = []
    bus.subscribe('t.a', (p) => {
      got.push(p)
    })
    bus.publish('t.a', { hello: 1 })
    await flushMicrotasks()
    expect(got).toHaveLength(1)
    expect(got[0]!.hello).toBe(1)
    expect(typeof got[0]!.ts).toBe('number')
    expect(got[0]!.source).toBe('core')
  })

  it('rejects non-serializable payloads without publishing', async () => {
    const bus = new Bus()
    let n = 0
    bus.subscribe('*', () => n++)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    bus.publish('t.a', circular)
    await flushMicrotasks()
    expect(n).toBe(0)
    expect(bus.statsSnapshot().published).toBe(0)
  })

  it('MemoryAdapter replay preserves order within [from, to]', async () => {
    const adapter = new MemoryAdapter()
    const bus = new Bus({ adapter, persistPrefixes: [] })
    const topics = ['service.ready', 'service.starting', 'service.stopped']
    for (const t of topics) bus.publish(t, { serviceId: 'x', version: '1' }, { persist: true })
    await flushMicrotasks()

    const replayed: string[] = []
    for await (const ev of bus.replay(1, 3)) replayed.push(ev.topic)
    expect(replayed).toEqual(topics)

    const filtered: string[] = []
    for await (const ev of bus.replay(1, 3, ['service.ready'])) filtered.push(ev.topic)
    expect(filtered).toEqual(['service.ready'])
  })

  it('persists events whose topic matches the whitelist prefix', async () => {
    const adapter = new MemoryAdapter()
    const bus = new Bus({ adapter, persistPrefixes: ['service.'] })
    bus.publish('service.x', { serviceId: 'x', version: '1' })
    bus.publish('hello.command.started', { ts: 1, source: 'test', requestId: 'r', text: 'hi' })
    await flushMicrotasks()
    expect(adapter.size).toBe(1)
  })

  it('ready() resolves for P1a adapters', async () => {
    const bus = new Bus()
    await expect(bus.ready()).resolves.toBeUndefined()
  })
})