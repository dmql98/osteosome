/**
 * stdio JSON-RPC 传输（RFC §3.4 / §6.3 / WS-5）——
 * 与 Core **同一分帧规范、独立实现**（防协议耦合，测试可对拍）。
 *
 * 帧格式：
 * ```
 * Content-Length: <bytes>\r\n\r\n<body utf8>
 * ```
 *
 * - 流式解码：粘包 / 拆包 / UTF-8 跨块
 * - 非法头（缺 Content-Length / 超上限 / 头过长）→ {@link FramingError}（上层关连接）
 * - {@link StreamTransport} 绑定任意 Readable/Writable（stdio 或测试 PassThrough）
 * - {@link RpcPeer}：request/notify + 双向分发（Core → 服务的 ping/event/shutdown）
 */
import type { Readable, Writable } from 'node:stream'

// ── 分帧 ────────────────────────────────────────

/** 单帧 body 上限 */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** 头区字节上限（防无 `\r\n\r\n` 垃圾流无限累积） */
export const MAX_HEADER_BYTES = 8 * 1024

export type FramingErrorCode = 'invalid-header' | 'content-length-too-large' | 'header-too-long'

/** 协议级致命帧错误 —— 上层应关连接 */
export class FramingError extends Error {
  constructor(
    readonly code: FramingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FramingError'
  }
}

/** 编码一条 JSON-RPC 消息为 Content-Length 帧 */
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([head, body])
}

/** 流式分帧解码器：push chunk，吐出完整 JSON 字符串（按帧） */
export class FrameDecoder {
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
          // 这里统计的是当前尚未遇到分隔符的 header buffer，而不是本次 push 的
          // 原始 chunk。后者可能还包含上一帧的 body，会把合法大帧误判成超长头。
          this.headerBytes = buf.length
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

// ── 传输 ────────────────────────────────────────

/** 抽象传输：send 出帧，onMessage 收已解码 JSON */
export interface Transport {
  send(msg: unknown): void
  onMessage(handler: (msg: unknown) => void): void
  onError(handler: (err: unknown) => void): void
  onClose(handler: () => void): void
  close(): void
}

/** 基于任意 Readable/Writable 的分帧传输（stdio 或测试流） */
export class StreamTransport implements Transport {
  private readonly decoder: FrameDecoder
  private messageHandlers: Array<(msg: unknown) => void> = []
  private errorHandlers: Array<(err: unknown) => void> = []
  private closeHandlers: Array<() => void> = []
  private closed = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    maxMessageBytes?: number,
  ) {
    this.decoder = new FrameDecoder(maxMessageBytes)
    this.input.on('data', (chunk: Buffer) => this.onData(chunk))
    this.input.on('error', (err) => this.emitError(err))
    this.input.on('close', () => this.emitClose())
    this.output.on('error', (err) => this.emitError(err))
  }

  send(msg: unknown): void {
    if (this.closed || this.output.destroyed || this.output.writableEnded) return
    this.output.write(encodeFrame(msg))
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.messageHandlers.push(handler)
  }

  onError(handler: (err: unknown) => void): void {
    this.errorHandlers.push(handler)
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.removeAllListeners('data')
    // 不 destroy 生产 stdio（进程退出自然回收）；测试流由用例自理
  }

  private onData(chunk: Buffer): void {
    let frames: string[]
    try {
      frames = this.decoder.push(chunk)
    } catch (err) {
      this.emitError(err)
      return
    }
    for (const raw of frames) {
      let msg: unknown
      try {
        msg = JSON.parse(raw)
      } catch {
        this.emitError(new FramingError('invalid-header', 'frame body is not valid JSON'))
        continue
      }
      for (const h of this.messageHandlers) h(msg)
    }
  }

  private emitError(err: unknown): void {
    for (const h of this.errorHandlers) h(err)
  }

  private emitClose(): void {
    if (this.closed) return
    this.closed = true
    for (const h of this.closeHandlers) h()
  }
}

/** 进程 stdio 传输（stdout 出、stdin 入）—— 协议流与 stderr 日志分离 */
export function createStdioTransport(): StreamTransport {
  return new StreamTransport(process.stdin, process.stdout)
}

// ── JSON-RPC peer ───────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** 请求超时错误 */
export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
  }
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 服务侧 JSON-RPC peer：
 * - service → Core：request（initialize / bus.*）/ notify（initialized / health.pong / shutdown）
 * - Core → 服务：onRequest / onNotification（health.ping / bus.event / shutdown）
 */
export class RpcPeer {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private requestTimeoutMs: number
  private notificationHandlers: Array<(method: string, params: unknown) => void> = []
  private requestHandlers: Array<(method: string, params: unknown) => unknown> = []
  private errorHandlers: Array<(err: unknown) => void> = []
  private closed = false

  constructor(
    private readonly transport: Transport,
    options: { requestTimeoutMs?: number } = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    transport.onMessage((msg) => this.handleMessage(msg))
    transport.onError((err) => this.emitError(err))
    transport.onClose(() => this.close())
  }

  /** 注册通知分发（可多个模块挂接）；返回 disposer */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.push(handler)
    return () => {
      const i = this.notificationHandlers.indexOf(handler)
      if (i >= 0) this.notificationHandlers.splice(i, 1)
    }
  }

  /** 注册请求分发（Core → 服务若带 id）；返回 disposer */
  onRequest(handler: (method: string, params: unknown) => unknown): () => void {
    this.requestHandlers.push(handler)
    return () => {
      const i = this.requestHandlers.indexOf(handler)
      if (i >= 0) this.requestHandlers.splice(i, 1)
    }
  }

  onError(handler: (err: unknown) => void): () => void {
    this.errorHandlers.push(handler)
    return () => {
      const i = this.errorHandlers.indexOf(handler)
      if (i >= 0) this.errorHandlers.splice(i, 1)
    }
  }

  /** 带超时的请求（pending 表配对 id） */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error('rpc closed'))
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const ms = timeoutMs ?? this.requestTimeoutMs
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcTimeoutError(method, ms))
      }, ms)
      timer.unref?.()
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject, timer })
      this.transport.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
    })
  }

  /** 通知（无 id） */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.transport.send({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('connection closed'))
    }
    this.pending.clear()
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      this.emitError(new FramingError('invalid-header', 'frame body is not an object'))
      return
    }
    const record = msg as JsonRpcMessage
    const hasId = typeof record.id === 'number' || typeof record.id === 'string'

    if (typeof record.method === 'string') {
      if (hasId) {
        // Core → 服务的请求：异步跑 handler 再回响应
        void this.dispatchRequest(record, record.id as number | string)
      } else {
        for (const h of this.notificationHandlers) {
          try {
            h(record.method, record.params)
          } catch (err) {
            this.emitError(err)
          }
        }
      }
      return
    }

    // 响应（service → Core 的 request 配对）
    if (hasId) {
      const pending = this.pending.get(record.id as number)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(record.id as number)
      if (record.error) {
        pending.reject(
          new Error(`JSON-RPC error ${record.error.code ?? '?'}: ${record.error.message ?? 'unknown'}`),
        )
      } else {
        pending.resolve(record.result)
      }
    }
  }

  private async dispatchRequest(msg: JsonRpcMessage, id: number | string): Promise<void> {
    try {
      let result: unknown = undefined
      for (const h of this.requestHandlers) {
        const r = h(msg.method as string, msg.params)
        result = (await r) ?? result
      }
      this.transport.send({ jsonrpc: '2.0', id, result: result ?? { ok: true } })
    } catch (err) {
      const e = err as { message?: string } | undefined
      this.transport.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: String(e?.message ?? err) },
      })
    }
  }

  private emitError(err: unknown): void {
    for (const h of this.errorHandlers) h(err)
  }
}
