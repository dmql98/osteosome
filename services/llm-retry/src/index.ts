/**
 * llm-retry —— retry 声明消费 + usage 记账 + retry 执行器装配（P2 WS-7 + P4 WS-2）。
 *
 * - 收 `llm.provider.registered` 存 retry 声明（主位透传 ProviderDescriptor）；`unregistered` 摘除；
 * - 收 `llm.request` 记住原始请求（重试时要重发的 payload：provider/model/messages）；
 * - 收 `llm.request.started` 记 requestId → provider（finished/failed 契约不带 provider）+ 尝试次数 +1；
 * - 收 `llm.token.streamed` 标记该请求**已出首块**（流已开 → 失败不自动续）；
 * - 收 `llm.request.finished` → 记 usage 发 `llm.metrics.usage { requestId, provider, usage }`；
 * - 收 `llm.request.failed` → 记账 + **retry 执行器**：读 provider 声明的 RetryPolicy，
 *   瞬态错误且未出首块且未到 maxAttempts → 退避（backoff+jitter）后重发 `llm.request`。
 *
 * 旁路服务：不参与请求成功路径，只做声明消费 + 记账 + 失败重试。
 */
import { Service } from '@osteosome/service-sdk'
import type { ProviderDeclaration } from './accounting'
import {
  recordFailure,
  recordUsage,
  rememberRequestProvider,
  removeDeclaration,
  upsertDeclaration,
  type ProviderByRequest,
} from './accounting'
import { shouldRetry } from './retry/engine'

const service = new Service({ id: 'llm-retry', version: '1.0.0' })

/** provider → retry 声明（registered 存 / unregistered 摘） */
const declarations = new Map<string, ProviderDeclaration>()
/** requestId → provider（started 记，供 finished 记账回填 provider） */
const requestProviders: ProviderByRequest = new Map()
/** requestId → 原始 llm.request payload（重试时重发） */
const originalRequests = new Map<string, Record<string, unknown>>()
/** requestId → 已尝试次数（每次 started +1） */
const attempts = new Map<string, number>()
/** requestId → 是否已出首块（token.streamed 记） */
const streamed = new Set<string>()

service.subscribe('llm.provider.registered', (payload) => {
  upsertDeclaration(payload as Record<string, unknown>, declarations)
  console.error(`[llm-retry] registered=${(payload as { provider?: string }).provider} declarations=${[...declarations.keys()].join(',')}`)
})

service.subscribe('llm.provider.unregistered', (payload) => {
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  removeProvider(provider)
})

function removeProvider(provider: string): void {
  removeDeclaration(provider, declarations)
}

service.subscribe('llm.request', (payload) => {
  // 记住原始请求（重试重发用）；provider/model/messages 齐全才算
  const p = payload as Record<string, unknown>
  const requestId = typeof p.requestId === 'string' ? p.requestId : ''
  if (requestId) originalRequests.set(requestId, p)
})

service.subscribe('llm.request.started', (payload) => {
  rememberRequestProvider(payload as Record<string, unknown>, requestProviders)
  const requestId = typeof (payload as Record<string, unknown>).requestId === 'string'
    ? (payload as Record<string, unknown>).requestId as string
    : ''
  if (requestId) attempts.set(requestId, (attempts.get(requestId) ?? 0) + 1)
})

service.subscribe('llm.token.streamed', (payload) => {
  const requestId = typeof (payload as Record<string, unknown>).requestId === 'string'
    ? (payload as Record<string, unknown>).requestId as string
    : ''
  if (requestId) streamed.add(requestId)
})

service.subscribe('llm.request.finished', (payload) => {
  const record = recordUsage(payload as Record<string, unknown>, declarations, requestProviders)
  const requestId = typeof (payload as Record<string, unknown>).requestId === 'string'
    ? (payload as Record<string, unknown>).requestId as string
    : ''
  if (requestId) {
    requestProviders.delete(requestId)
    originalRequests.delete(requestId)
    attempts.delete(requestId)
    streamed.delete(requestId)
  }
  if (!record?.usage) return
  service.publish('llm.metrics.usage', {
    requestId: record.requestId,
    provider: record.provider,
    usage: record.usage,
  })
})

service.subscribe('llm.request.failed', (payload) => {
  const record = recordFailure(payload as Record<string, unknown>, declarations, requestProviders)
  const requestId = typeof (payload as Record<string, unknown>).requestId === 'string'
    ? (payload as Record<string, unknown>).requestId as string
    : ''
  if (!requestId || !record) return

  // retry 执行器（P4）：读 provider 声明判定是否重试
  const policy = declarations.get(record.provider)?.retryPolicy
  const decision = shouldRetry({
    policy,
    attempts: attempts.get(requestId) ?? 1,
    streamed: streamed.has(requestId),
    error: record.error,
  })

  if (decision.retry) {
    const original = originalRequests.get(requestId)
    if (original) {
      // 退避后重发同一请求（新 requestId 让上层视为新一轮；这里沿用原 requestId 保持对账）
      const timer = setTimeout(() => {
        service.publish('llm.request', original)
      }, decision.delayMs)
      timer.unref?.()
      return
    }
  }

  // 不重试：清理（失败无 usage 可记，不发 metrics）
  requestProviders.delete(requestId)
  originalRequests.delete(requestId)
  attempts.delete(requestId)
  streamed.delete(requestId)
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`llm-retry: failed to start: ${String(err)}`)
  process.exit(1)
})
