/**
 * Core 侧 JSON-RPC 客户端（RFC §3.5）—— 双向 stdio 连接封装。
 *
 * - Core → 服务方向的请求/通知：request()（带超时，pending 表）/ notify()
 * - 服务 → Core 方向的请求/通知：onRequest 回调（Core 自动回响应）/ onNotification
 * - 帧错误（FramingError）→ onError，由上层关连接 + 标记 failed + 触发重启
 */
import type { JsonRpcRequest, JsonRpcResponse } from '@osteosome/shared'
import { logger } from '../../logger'
import { FramingDecoder, encodeMessage, FramingError } from './framing'

/** stdio 写侧抽象（进程 stdin 或测试替身） */
export interface RpcConnection {
  write(chunk: Buffer): void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export interface JsonRpcClientOptions {
  conn: RpcConnection
  maxMessageBytes?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** 请求超时错误 */
export class RpcTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
  }
}

export class JsonRpcClient {
  private readonly decoder: FramingDecoder
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  /** 服务 → Core 请求分发；Return 值自动作为 result 回给服务，抛错则回 error */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  /** 服务 → Core 通知分发（initialized / health.pong / shutdown ...） */
  onNotification?: (method: string, params: unknown) => void
  /** 连接/协议级错误（FramingError 等）→ 上层标记 failed */
  onError?: (err: unknown) => void
  /** 连接将关闭（进程退出 / 主动关）便于上层清理 */
  onClose?: () => void

  constructor(private readonly options: JsonRpcClientOptions) {
    this.decoder = new FramingDecoder(options.maxMessageBytes)
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcTimeoutError(method, timeoutMs ?? this.requestTimeoutMs))
      }, timeoutMs ?? this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
        timer,
      })
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  handleChunk(chunk: Buffer): void {
    let messages: string[]
    try {
      messages = this.decoder.push(chunk)
    } catch (err) {
      this.onError?.(err)
      return
    }
    for (const raw of messages) {
      let msg: unknown
      try {
        msg = JSON.parse(raw)
      } catch {
        this.onError?.(new FramingError('invalid-header', 'frame body is not valid JSON'))
        return
      }
      this.handleMessage(msg)
    }
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('connection closed'))
    }
    this.pending.clear()
  }

  /** 空助手：触发 onClose（进程退出时由上层调用） */
  emitClose(): void {
    this.onClose?.()
  }

  private send(msg: JsonRpcRequest): void {
    this.options.conn.write(encodeMessage(msg))
  }

  private respond(reqId: number | string, result: unknown, error?: { code: number; message: string; data?: unknown }): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id: reqId }
    if (error) msg.error = error
    else msg.result = result
    this.sendRaw(msg)
  }

  private sendRaw(msg: JsonRpcResponse): void {
    this.options.conn.write(encodeMessage(msg))
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      this.onError?.(new FramingError('invalid-header', 'frame body is not an object'))
      return
    }
    const record = msg as Record<string, unknown>
    const hasId = typeof record.id === 'number' || typeof record.id === 'string'
    if (typeof record.method === 'string') {
      // 服务 → Core 的请求或通知
      if (hasId) {
        const p = this.onRequest?.(record.method, record.params)
        Promise.resolve(p).then(
          (result) => this.respond(record.id as number | string, result),
          (err) => {
            const e = err as { message?: string } | undefined
            this.respond(record.id as number | string, undefined, {
              code: -32000,
              message: String(e?.message ?? err),
            })
          },
        )
      } else {
        this.onNotification?.(record.method, record.params)
      }
      return
    }
    // 响应
    if (hasId) {
      const pending = this.pending.get(record.id as number)
      if (!pending) {
        logger.debug(`jsonrpc: response for unknown request id=${String(record.id)} ignored`)
        return
      }
      pending.timer.unref?.()
      clearTimeout(pending.timer)
      this.pending.delete(record.id as number)
      if (record.error) {
        const err = record.error as { code?: number; message?: string }
        pending.reject(new Error(`JSON-RPC error ${err.code ?? '?'}: ${err.message ?? 'unknown'}`))
      } else {
        pending.resolve(record.result)
      }
    }
  }
}