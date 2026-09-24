import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_MESSAGE_BYTES, FramingDecoder, FramingError, encodeMessage } from '../src/service-manager/jsonrpc'

describe('jsonrpc framing', () => {
  it('encodes and decodes a roundtrip message', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } }
    const frame = encodeMessage(msg)
    expect(frame.subarray(0, 32).toString('ascii')).toMatch(/^Content-Length: \d+\r\n\r\n/)
    const decoder = new FramingDecoder()
    const msgs = decoder.push(frame)
    expect(msgs).toHaveLength(1)
    expect(JSON.parse(msgs[0])).toEqual(msg)
  })

  it('handles 粘包: one chunk containing multiple frames', () => {
    const a = encodeMessage({ jsonrpc: '2.0', id: 1, result: 'a' })
    const b = encodeMessage({ jsonrpc: '2.0', id: 2, result: 'b' })
    const decoder = new FramingDecoder()
    const msgs = decoder.push(Buffer.concat([a, b]))
    expect(msgs.map((m) => JSON.parse(m))).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'a' },
      { jsonrpc: '2.0', id: 2, result: 'b' },
    ])
  })

  it('handles 拆包: frame split across chunks (header split, body split)', () => {
    const frame = encodeMessage({ jsonrpc: '2.0', id: 9, method: 'health.ping' })
    const decoder = new FramingDecoder()
    // 逐个字节喂入，最彻底的拆包验证
    const all: string[] = []
    for (const byte of frame) {
      all.push(...decoder.push(Buffer.from([byte])))
    }
    expect(all).toHaveLength(1)
    expect(JSON.parse(all[0])).toEqual({ jsonrpc: '2.0', id: 9, method: 'health.ping' })
  })

  it('handles UTF-8 多字节字符跨块拆分', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'bus.event', params: { text: '中文内容ß🎯' } }
    const frame = encodeMessage(msg)
    const split = Math.floor(frame.length / 2)
    const decoder = new FramingDecoder()
    const first = decoder.push(frame.subarray(0, split))
    const second = decoder.push(frame.subarray(split))
    // 第二个 chunk 可能含 0 或 1 条完整消息（取决于切点）
    const msgs = [...first, ...second]
    expect(msgs).toHaveLength(1)
    expect(JSON.parse(msgs[0])).toEqual(msg)
  })

  it('rejects frame without Content-Length header (非法头 → FramingError)', () => {
    const decoder = new FramingDecoder()
    expect(() =>
      decoder.push(Buffer.from('Content-Type: application/json\r\n\r\n{}')),
    ).toThrow(FramingError)
  })

  it('rejects frame with malformed Content-Length', () => {
    const decoder = new FramingDecoder()
    expect(() =>
      decoder.push(Buffer.from('Content-Length: abc\r\n\r\n{}')),
    ).toThrow(FramingError)
  })

  it('rejects Content-Length exceeding max message size', () => {
    const decoder = new FramingDecoder(1024)
    expect(() =>
      decoder.push(Buffer.from(`Content-Length: ${1025}\r\n\r\n${'x'.repeat(1025)}`)),
    ).toThrow(FramingError)
  })

  it('rejects garbage stream with no frame terminator (header-too-long)', () => {
    const decoder = new FramingDecoder()
    expect(() => decoder.push(Buffer.alloc(9_000, 'a'))).toThrow(FramingError)
  })

  it('const references are exported', () => {
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024)
  })
})