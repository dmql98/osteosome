import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SseClient } from '../../src/core-sdk/sse'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  closed = false
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  close(): void { this.closed = true }
  emit(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('SseClient', () => {
  beforeEach(() => { FakeEventSource.instances = []; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function create(now = () => Date.now()): SseClient {
    return new SseClient({ createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource, now, watchdogIntervalMs: 30_000, silenceTimeoutMs: 90_000 })
  }

  it('单连接合并 topics，并按通配符分发 payload', () => {
    const client = create()
    const a = vi.fn(); const b = vi.fn(); const all = vi.fn()
    client.subscribe('a', a)
    client.subscribe('b', b)
    client.subscribe('*', all)
    expect(FakeEventSource.instances).toHaveLength(3)
    expect(FakeEventSource.instances[2].url).toContain('a%2Cb%2C*')
    const es = FakeEventSource.instances[2]
    es.emit('open')
    expect(client.getState()).toBe('connected')
    es.emit('message', JSON.stringify({ topic: 'a', payload: { value: 1 } }))
    expect(a).toHaveBeenCalledWith({ value: 1 }, 'a')
    expect(all).toHaveBeenCalledWith({ value: 1 }, 'a')
    expect(b).not.toHaveBeenCalled()
    client.close()
  })

  it('退订最后一个 handler 后关闭连接，退订一个 topic 会重建剩余 topics', () => {
    const client = create()
    const a = vi.fn(); const b = vi.fn()
    const disposeA = client.subscribe('a', a)
    const disposeB = client.subscribe('b', b)
    expect(FakeEventSource.instances).toHaveLength(2)
    disposeA()
    expect(FakeEventSource.instances).toHaveLength(3)
    expect(FakeEventSource.instances[2].url).toContain('b')
    disposeB()
    expect(client.getState()).toBe('disconnected')
    expect(FakeEventSource.instances.at(-1)?.closed).toBe(true)
  })

  it('静默超过 90 秒主动重建连接', () => {
    let now = 0
    const client = create(() => now)
    client.subscribe('a', vi.fn())
    expect(FakeEventSource.instances).toHaveLength(1)
    now = 90_001
    vi.advanceTimersByTime(30_000)
    expect(FakeEventSource.instances).toHaveLength(2)
    client.close()
  })

  it('EventSource error 进入 reconnecting', () => {
    const client = create()
    client.subscribe('a', vi.fn())
    FakeEventSource.instances[0].emit('error')
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })
})
