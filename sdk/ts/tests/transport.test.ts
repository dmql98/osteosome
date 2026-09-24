import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  FramingError,
  FrameDecoder,
  RpcPeer,
  RpcTimeoutError,
  StreamTransport,
  encodeFrame,
  type JsonRpcMessage,
} from '../src/transport'

function capture(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (err) {
    return err
  }
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 单个 RpcPeer 的测试对端：toPeer=远端→peer，fromPeer=peer→远端 */
function createHarness(requestTimeoutMs?: number) {
  const toPeer = new PassThrough()
  const fromPeer = new PassThrough()
  const transport = new StreamTransport(toPeer, fromPeer)
  const peer = new RpcPeer(transport, requestTimeoutMs !== undefined ? { requestTimeoutMs } : {})
  const received: JsonRpcMessage[] = []
  const decoder = new FrameDecoder()
  fromPeer.on('data', (chunk: Buffer) => {
    for (const raw of decoder.push(chunk)) received.push(JSON.parse(raw) as JsonRpcMessage)
  })
  const send = (msg: unknown) => toPeer.write(encodeFrame(msg))
  return { peer, received, send }
}

describe('frame codec', () => {
  it('encode → decode roundtrip', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } }
    const frame = encodeFrame(msg)
    expect(frame.subarray(0, 16).toString('ascii')).toBe('Content-Length: ')
    const out = new FrameDecoder().push(frame)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0])).toEqual(msg)
  })

  it('Content-Length is byte length, not char length', () => {
    const msg = { jsonrpc: '2.0', method: 'm', params: { text: '你好' } }
    const frame = encodeFrame(msg)
    const head = frame.indexOf('\r\n\r\n')
    const declared = Number(/Content-Length:\s*(\d+)/i.exec(frame.subarray(0, head).toString('ascii'))![1])
    expect(declared).toBe(frame.length - head - 4)
    expect(declared).toBe(Buffer.byteLength(JSON.stringify(msg), 'utf8'))
  })

  it('sticky packets: multiple frames in one chunk', () => {
    const d = new FrameDecoder()
    const m1 = { jsonrpc: '2.0', id: 1, method: 'a' }
    const m2 = { jsonrpc: '2.0', id: 2, method: 'b' }
    const out = d.push(Buffer.concat([encodeFrame(m1), encodeFrame(m2)]))
    expect(out.map((r) => JSON.parse(r))).toEqual([m1, m2])
  })

  it('split packets: frame divided across chunks (header/body boundary)', () => {
    const d = new FrameDecoder()
    const msg = { jsonrpc: '2.0', method: 'x', params: { n: 42 } }
    const frame = encodeFrame(msg)
    const headEnd = frame.indexOf('\r\n\r\n') + 4
    const out = [
      ...d.push(frame.subarray(0, headEnd - 2)),
      ...d.push(frame.subarray(headEnd - 2, headEnd + 1)),
      ...d.push(frame.subarray(headEnd + 1)),
    ]
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0])).toEqual(msg)
  })

  it('split packets: byte-by-byte across a multi-byte UTF-8 char', () => {
    const d = new FrameDecoder()
    const msg = { jsonrpc: '2.0', method: 'x', params: { text: '你好🚀' } }
    const frame = encodeFrame(msg)
    const out: string[] = []
    for (let i = 0; i < frame.length; i++) {
      out.push(...d.push(frame.subarray(i, i + 1)))
    }
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0])).toEqual(msg)
  })

  it('decoder continues with remaining frames after a complete one', () => {
    const d = new FrameDecoder()
    const m1 = { jsonrpc: '2.0', id: 1, method: 'a' }
    const m2 = { jsonrpc: '2.0', id: 2, method: 'b' }
    const out = d.push(Buffer.concat([encodeFrame(m1), encodeFrame(m2).subarray(0, 10)]))
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0])).toEqual(m1)
    expect(d.push(encodeFrame(m2).subarray(10))).toHaveLength(1)
  })

  it('invalid header: missing Content-Length → FramingError', () => {
    const err = capture(() => new FrameDecoder().push(Buffer.from('Garbage\r\n\r\n')))
    expect(err).toBeInstanceOf(FramingError)
    expect((err as FramingError).code).toBe('invalid-header')
  })

  it('invalid header: non-numeric Content-Length → FramingError', () => {
    const err = capture(() => new FrameDecoder().push(Buffer.from('Content-Length: abc\r\n\r\n')))
    expect(err).toBeInstanceOf(FramingError)
    expect((err as FramingError).code).toBe('invalid-header')
  })

  it('content-length too large (custom cap) → FramingError', () => {
    const err = capture(() => new FrameDecoder(100).push(Buffer.from('Content-Length: 200\r\n\r\n')))
    expect(err).toBeInstanceOf(FramingError)
    expect((err as FramingError).code).toBe('content-length-too-large')
  })

  it('content-length too large (default 16MB cap) → FramingError', () => {
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024)
    const err = capture(() => new FrameDecoder().push(Buffer.from('Content-Length: 9999999999\r\n\r\n')))
    expect(err).toBeInstanceOf(FramingError)
    expect((err as FramingError).code).toBe('content-length-too-large')
  })

  it('header too long (no CRLFCRLF, accumulates past 8KB) → FramingError', () => {
    const err = capture(() => new FrameDecoder().push(Buffer.alloc(9000, 0x41)))
    expect(err).toBeInstanceOf(FramingError)
    expect((err as FramingError).code).toBe('header-too-long')
  })

  it('header too long across multiple chunks', () => {
    const d = new FrameDecoder()
    const err = capture(() => {
      d.push(Buffer.alloc(5000, 0x41))
      d.push(Buffer.alloc(4000, 0x42))
    })
    expect(err).toBeInstanceOf(FramingError)
    expect((err as FramingError).code).toBe('header-too-long')
  })
})

describe('StreamTransport', () => {
  it('send encodes; incoming frames dispatch to onMessage', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const t = new StreamTransport(input, output)
    const got: unknown[] = []
    t.onMessage((m) => got.push(m))

    const sent: unknown[] = []
    const d = new FrameDecoder()
    output.on('data', (c: Buffer) => {
      for (const raw of d.push(c)) sent.push(JSON.parse(raw))
    })

    t.send({ jsonrpc: '2.0', id: 1, method: 'hi' })
    await until(() => sent.length === 1)
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'hi' })

    input.write(encodeFrame({ jsonrpc: '2.0', method: 'back', params: { ok: true } }))
    await until(() => got.length === 1)
    expect(got[0]).toEqual({ jsonrpc: '2.0', method: 'back', params: { ok: true } })
  })

  it('frame body that is not valid JSON → onError(FramingError)', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const t = new StreamTransport(input, output)
    const errors: unknown[] = []
    t.onError((e) => errors.push(e))
    input.write(Buffer.from('Content-Length: 5\r\n\r\nhello'))
    await until(() => errors.length === 1)
    expect(errors[0]).toBeInstanceOf(FramingError)
    expect((errors[0] as FramingError).code).toBe('invalid-header')
  })

  it('after close, incoming data is ignored', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const t = new StreamTransport(input, output)
    const got: unknown[] = []
    t.onMessage((m) => got.push(m))
    t.close()
    input.write(encodeFrame({ jsonrpc: '2.0', method: 'late' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(got).toHaveLength(0)
  })
})

describe('RpcPeer', () => {
  it('request pairs response by id and resolves result', async () => {
    const h = createHarness()
    const p = h.peer.request('bus.publish', { topic: 't' })
    await until(() => h.received.length === 1)
    const req = h.received[0]
    expect(req.id).toBeDefined()
    expect(req.method).toBe('bus.publish')
    h.send({ jsonrpc: '2.0', id: req.id, result: { ok: true } })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('error response rejects the request', async () => {
    const h = createHarness()
    const p = h.peer.request('initialize', {})
    await until(() => h.received.length === 1)
    h.send({ jsonrpc: '2.0', id: h.received[0].id, error: { code: -32000, message: 'boom' } })
    await expect(p).rejects.toThrow('JSON-RPC error -32000: boom')
  })

  it('request timeout rejects with RpcTimeoutError', async () => {
    const h = createHarness(30)
    await expect(h.peer.request('slow', {})).rejects.toBeInstanceOf(RpcTimeoutError)
  })

  it('concurrent requests pair by distinct ids', async () => {
    const h = createHarness()
    const p1 = h.peer.request('a')
    const p2 = h.peer.request('b')
    await until(() => h.received.length === 2)
    const [r1, r2] = h.received
    expect(r1.id).not.toBe(r2.id)
    h.send({ jsonrpc: '2.0', id: r2.id, result: 'B' })
    h.send({ jsonrpc: '2.0', id: r1.id, result: 'A' })
    await expect(p1).resolves.toBe('A')
    await expect(p2).resolves.toBe('B')
  })

  it('notify sends without id', async () => {
    const h = createHarness()
    h.peer.notify('initialized')
    await until(() => h.received.length === 1)
    expect(h.received[0].id).toBeUndefined()
    expect(h.received[0].method).toBe('initialized')
  })

  it('incoming notifications dispatch to onNotification; disposer detaches', async () => {
    const h = createHarness()
    const got: Array<[string, unknown]> = []
    const dispose = h.peer.onNotification((m, p) => got.push([m, p]))
    h.send({ jsonrpc: '2.0', method: 'health.ping' })
    await until(() => got.length === 1)
    expect(got[0]).toEqual(['health.ping', undefined])
    dispose()
    h.send({ jsonrpc: '2.0', method: 'health.ping' })
    await new Promise((r) => setTimeout(r, 30))
    expect(got).toHaveLength(1)
  })

  it('incoming request (with id) dispatches to onRequest and responds', async () => {
    const h = createHarness()
    h.peer.onRequest((m, p) => (m === 'echo' ? { echoed: p } : undefined))
    h.send({ jsonrpc: '2.0', id: 99, method: 'echo', params: { a: 1 } })
    await until(() => h.received.some((m) => m.id === 99 && m.result !== undefined))
    const resp = h.received.find((m) => m.id === 99)!
    expect(resp.result).toEqual({ echoed: { a: 1 } })
    expect(resp.method).toBeUndefined()
  })

  it('close rejects all in-flight requests', async () => {
    const h = createHarness()
    const p = h.peer.request('never', {}, 10_000)
    h.peer.close()
    await expect(p).rejects.toThrow('connection closed')
    await expect(h.peer.request('after-close')).rejects.toThrow('rpc closed')
  })
})
