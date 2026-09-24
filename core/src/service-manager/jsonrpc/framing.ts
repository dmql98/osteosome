/**
 * JSON-RPC `Content-Length` 分帧（RFC §3.4 / LSP 同款）。
 *
 * 帧格式：
 * ```
 * Content-Length: 123\r\n\r\n{"jsonrpc":"2.0",...}
 * ```
 *
 * 解码器语义：
 * - 流式累积原始字节，处理粘包 / 拆包 / UTF-8 跨块（body 收齐后才按 utf8 整体解码）
 * - 非法 `Content-Length`（非数字 / 头太长 / 超上限）→ 抛 {@link FramingError}
 *   —— 上层据此「关该服务 stdio 连接 + 标记 failed + 触发重启」（补强 ①，不重对齐）
 */

/** 单帧 body 上限（防超大帧撑爆内存） */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** 头区字节上限（防无 `\r\n\r\n` 的垃圾流无限累积） */
export const MAX_HEADER_BYTES = 8 * 1024

export type FramingErrorCode =
  | 'invalid-header'
  | 'content-length-too-large'
  | 'header-too-long'

/** 协议级致命帧错误 —— 上层必须关连接 + 标记 failed + 触发重启 */
export class FramingError extends Error {
  constructor(
    readonly code: FramingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FramingError'
  }
}

/** 编码一条消息为 `Content-Length` 头的帧 */
export function encodeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([head, body])
}

/** 流式解码器：push 进 chunk，返回完整解码出的 JSON 字符串（按帧） */
export class FramingDecoder {
  private chunks: Buffer[] = []
  private headerBytes = 0
  private contentLength: number | null = null

  constructor(private readonly maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): string[] {
    const messages: string[] = []
    this.chunks.push(chunk)
    for (;;) {
      if (this.contentLength === null) {
        const buf = this.buffer()
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) {
          this.headerBytes += chunk.length
          if (this.headerBytes > MAX_HEADER_BYTES) {
            throw new FramingError('header-too-long', 'header block exceeds limit')
          }
          return messages
        }
        const header = buf.subarray(0, idx).toString('ascii')
        const match = /\r?\n?Content-Length:\s*(\d+)/i.exec(header)
        if (!match) {
          throw new FramingError(
            'invalid-header',
            `missing or malformed Content-Length in header: ${header.slice(0, 64)}`,
          )
        }
        const len = Number(match[1])
        if (len > this.maxMessageBytes) {
          throw new FramingError(
            'content-length-too-large',
            `Content-Length ${len} exceeds max ${this.maxMessageBytes}`,
          )
        }
        this.contentLength = len
        this.chunks = [buf.subarray(idx + 4)]
        this.headerBytes = 0
      }
      const buf = this.buffer()
      if (buf.length < this.contentLength) return messages
      const body = buf.subarray(0, this.contentLength)
      messages.push(body.toString('utf8'))
      this.chunks = [buf.subarray(this.contentLength)]
      this.contentLength = null
    }
  }

  private buffer(): Buffer {
    if (this.chunks.length === 1) return this.chunks[0]
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = Buffer.allocUnsafe(total)
    let off = 0
    for (const c of this.chunks) {
      c.copy(out, off)
      off += c.length
    }
    this.chunks = [out]
    return out
  }
}