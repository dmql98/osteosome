/**
 * 凭证客户端（P2 WS-2）—— provider 能力位 → credentials 能力位的一次性解析配对。
 *
 * 契约（shared/src/events.ts §5，只增不改）：
 * - 发送命令 `credentials.resolve { requestId, ref }`（走 bus.publish，广播给 credentials 服务）；
 * - 订阅事件 `credentials.resolved { requestId, apiKey?, error? }` 配对返回。
 *
 * 语义：
 * - **只有一条在途 resolve**：凭证解析是「一次性取值」，同一服务进程内不并发多个解析——
 *   调用方需串行（provider 服务的 llm.provider.request handler 本就是串行流）。
 *   若在途解析未完成又被调用 → 立即 reject（fail fast，杜绝串配）。
 * - `requestId` 复用调用方请求链上的 requestId（溯源到同一 LLM 请求），独立生成反而不利于对账。
 * - 成功 `{ apiKey }`；失败 `{ error }` → reject 带 `error`（含 code/message），不吞错。
 * - 凭证值只在本服务进程内短暂持有（用于上游鉴权），不落盘、不发布到 SSE/前端。
 */
import type { StreamError } from '@osteosome/shared'
import type { Service } from './service'

export interface ResolvedCredential {
  apiKey: string
}

/** resolve 被并发调用 / 超时等异常 → reject 的错误 */
export class CredentialClientError extends Error {
  constructor(
    readonly reason: 'concurrent' | 'timeout' | 'closed',
    message: string,
    readonly error?: StreamError,
  ) {
    super(message)
    this.name = 'CredentialClientError'
  }
}

export interface AttachCredentialClientOptions {
  /** resolve 等待 credentials.resolved 的超时 ms（默认 5000） */
  timeoutMs?: number
}

export interface CredentialClient {
  /** 发送 credentials.resolve，配对 credentials.resolved 后 resolve apiKey；失败 reject */
  resolve(ref: string, requestId: string): Promise<ResolvedCredential>
  /** 释放订阅；进程退出前调用（Service 停止会自动摘 handler，这里额外保险） */
  dispose(): void
}

/** 挂接凭证客户端到 Service（Service 内部用 bus 发命令 + 订阅事件配对） */
export function attachCredentialClient(
  service: Service,
  options: AttachCredentialClientOptions = {},
): CredentialClient {
  const timeoutMs = options.timeoutMs ?? 5000
  let pending: {
    requestId: string
    timer: ReturnType<typeof setTimeout>
    resolve: (value: ResolvedCredential) => void
    reject: (err: CredentialClientError) => void
  } | null = null
  let disposed = false

  const onResolved = (payload: Record<string, unknown>, topic: string): void => {
    if (topic !== 'credentials.resolved' || !pending) return
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    if (requestId !== pending.requestId) return // 只配对当前在途 requestId
    const current = pending
    pending = null
    clearTimeout(current.timer)
    const error = payload.error as StreamError | undefined
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      current.reject(new CredentialClientError('closed', `credentials.resolve failed: ${error.message ?? error.code}`, error))
      return
    }
    const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey : ''
    if (!apiKey) {
      current.reject(new CredentialClientError('closed', 'credentials.resolved missing apiKey'))
      return
    }
    current.resolve({ apiKey })
  }

  const disposer = service.subscribe('credentials.resolved', onResolved)

  return {
    resolve(ref, requestId) {
      if (disposed) return Promise.reject(new CredentialClientError('closed', 'credential client disposed'))
      if (pending) {
        return Promise.reject(
          new CredentialClientError('concurrent', 'credential resolve already in flight; serialize resolves'),
        )
      }
      if (typeof ref !== 'string' || !ref) {
        return Promise.reject(new CredentialClientError('closed', 'invalid credential ref', { code: 'missing_credential', message: `credential ref is required` }))
      }
      return new Promise<ResolvedCredential>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending?.requestId !== requestId) return
          pending = null
          reject(new CredentialClientError('timeout', `credentials.resolve timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
        pending = { requestId, timer, resolve, reject }
        service.publish('credentials.resolve', { requestId, ref })
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      disposer()
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new CredentialClientError('closed', 'credential client disposed'))
        pending = null
      }
    },
  }
}
