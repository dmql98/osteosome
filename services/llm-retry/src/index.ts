/**
 * llm-retry —— retry 声明消费 + usage 记账 + retry 执行器装配（P2 WS-7 + P4 WS-2）。
 *
 * - 收 `llm.provider.registered` 存 retry 声明（主位透传 ProviderDescriptor）；`unregistered` 摘除；
 * - 收 `llm.provider.request` 记**该请求**的 retryPolicy（主位按路由注入，与声明表同源）；
 * - 收 `llm.request` 记住原始请求（重试时要重发的 payload：provider/model/messages）；
 * - 收 `llm.request.started` 记 requestId → provider（finished/failed 契约不带 provider）+ 尝试次数 +1；
 * - 收 `llm.token.streamed` 标记该请求**已出首块**（流已开 → 失败不自动续）；
 * - 收 `llm.request.finished` → 记 usage 发 `llm.metrics.usage { requestId, provider, usage }`；
 * - 收 `llm.request.failed` → 记账 + **retry 执行器**：读该请求的 RetryPolicy，
 *   瞬态错误且未出首块且未到 maxAttempts → 退避（backoff+jitter）后重发 `llm.request`。
 *
 * 旁路服务：不参与请求成功路径，只做声明消费 + 记账 + 失败重试。
 *
 * **为什么策略按请求取而不是只读声明表**（P4 WS-5 收尾实证）：provider 在自己 `start()` 后立刻发
 * `llm.provider.registered`，而 Bus 没有「订阅即回放」——本服务若晚于 provider 启动，声明表恒空，
 * 429 用例判成 `no_policy` 不重试（红）。改为在 `llm.provider.request` 上取（该事件必然晚于本服务订阅，
 * 因为请求由前端/loop 发起），声明表退化为兜底。
 */
import { Service } from '@osteosome/service-sdk'
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@osteosome/shared'
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
/** requestId → 该请求的 retryPolicy（`llm.provider.request` 记，主位按路由注入） */
const policies = new Map<string, RetryPolicy>()

/** 归一 retryPolicy payload（畸形/缺字段 → 回落 DEFAULT_RETRY_POLICY） */
function parsePolicy(raw: unknown): RetryPolicy {
  if (!raw || typeof raw !== 'object') return DEFAULT_RETRY_POLICY
  const p = raw as Record<string, unknown>
  return {
    maxAttempts: typeof p.maxAttempts === 'number' ? p.maxAttempts : DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: typeof p.baseDelayMs === 'number' ? p.baseDelayMs : DEFAULT_RETRY_POLICY.baseDelayMs,
    backoff: p.backoff === 'exponential' ? 'exponential' : 'fixed',
    retryableCodes: Array.isArray(p.retryableCodes)
      ? p.retryableCodes.filter((c): c is string => typeof c === 'string')
      : [...DEFAULT_RETRY_POLICY.retryableCodes],
  }
}

service.subscribe('llm.provider.registered', (payload) => {
  upsertDeclaration(payload as Record<string, unknown>, declarations)
})

/** 主位转发请求时带上本次路由的 retryPolicy → 按请求记（与启动顺序解耦） */
service.subscribe('llm.provider.request', (payload) => {
  const p = payload as Record<string, unknown>
  const requestId = typeof p.requestId === 'string' ? p.requestId : ''
  if (requestId) policies.set(requestId, parsePolicy(p.retryPolicy))
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
    policies.delete(requestId)
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

  // retry 执行器（P4）：读**该请求**的策略（`llm.provider.request` 记），声明表兜底
  const policy = policies.get(requestId) ?? declarations.get(record.provider)?.retryPolicy
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
  policies.delete(requestId)
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`llm-retry: failed to start: ${String(err)}`)
  process.exit(1)
})
