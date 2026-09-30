/**
 * llm-retry —— retry 声明消费 + usage 记账纯逻辑（P2 WS-7）。
 *
 * 与装配解耦、可直测（对齐 WS-3/WS-5 策略）。三条职责：
 * 1. `applyDeclaration()` —— 收 `llm.provider.registered` 的 ProviderDescriptor 存 retry 声明（按 provider）；
 * 2. `recordUsage()` —— 收 `llm.request.finished` 归一 usage → `llm.metrics.usage` 输出行；
 * 3. `recordFailure()` —— 收 `llm.request.failed` 记失败（P2 只记账，不执行重试——重试执行器 P4 读声明 backoff+jitter）。
 */
import type { ProviderDescriptor, RetryPolicy, StreamError, Usage } from '@osteosome/shared'

export interface ProviderDeclaration {
  provider: string
  defaultModel: string
  credentialRef: string
  retryPolicy: RetryPolicy
}

/** 成功完成记账行（记 usage + 终态 finishReason） */
export interface UsageRecord {
  requestId: string
  provider: string
  usage?: Usage
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
}

/** 失败记账行（P2 只记事件，不重发） */
export interface FailureRecord {
  requestId: string
  provider: string
  error: StreamError
}

/** 归一化 `llm.request.finished` payload → UsageRecord（未知 provider 记 'unknown'） */
export function recordUsage(
  payload: Record<string, unknown>,
  declarations: Map<string, ProviderDeclaration>,
): UsageRecord | undefined {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return undefined
  const provider =
    typeof payload.provider === 'string' && payload.provider ? payload.provider : 'unknown'
  const finishReason = payload.finishReason as UsageRecord['finishReason']
  const rawUsage = payload.usage as Record<string, unknown> | undefined
  let usage: Usage | undefined
  if (rawUsage && typeof rawUsage === 'object') {
    const promptTokens = typeof rawUsage.promptTokens === 'number' ? rawUsage.promptTokens : 0
    const completionTokens =
      typeof rawUsage.completionTokens === 'number' ? rawUsage.completionTokens : 0
    if (promptTokens > 0 || completionTokens > 0) {
      usage = { promptTokens, completionTokens }
    }
  }
  return { requestId, provider, usage, finishReason }
}

/** 归一化 `llm.request.failed` payload → FailureRecord（未知 provider 记 'unknown'） */
export function recordFailure(
  payload: Record<string, unknown>,
  declarations: Map<string, ProviderDeclaration>,
): FailureRecord | undefined {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return undefined
  const provider =
    typeof payload.provider === 'string' && payload.provider ? payload.provider : 'unknown'
  const rawError = payload.error as StreamError | undefined
  const error: StreamError =
    rawError && typeof rawError === 'object' && typeof rawError.code === 'string'
      ? { code: rawError.code, message: typeof rawError.message === 'string' ? rawError.message : '' }
      : { code: 'unknown' as StreamError['code'], message: 'llm-retry: no error payload' }
  return { requestId, provider, error }
}

/** 归一化 `llm.provider.registered` payload → ProviderDeclaration 存声明表（主位透传 ProviderDescriptor） */
export function upsertDeclaration(
  payload: Record<string, unknown>,
  declarations: Map<string, ProviderDeclaration>,
): ProviderDeclaration | undefined {
  const provider = typeof payload.provider === 'string' && payload.provider ? payload.provider : ''
  if (!provider) return undefined
  const retryPolicy = payload.retryPolicy as RetryPolicy | undefined
  const declaration: ProviderDeclaration = {
    provider,
    defaultModel: typeof payload.defaultModel === 'string' ? payload.defaultModel : '',
    credentialRef: typeof payload.credentialRef === 'string' ? payload.credentialRef : '',
    retryPolicy:
      retryPolicy && typeof retryPolicy === 'object'
        ? {
            maxAttempts:
              typeof retryPolicy.maxAttempts === 'number' ? retryPolicy.maxAttempts : 1,
            baseDelayMs:
              typeof retryPolicy.baseDelayMs === 'number' ? retryPolicy.baseDelayMs : 0,
            backoff: retryPolicy.backoff === 'exponential' ? 'exponential' : 'fixed',
            retryableCodes: Array.isArray(retryPolicy.retryableCodes)
              ? retryPolicy.retryableCodes
              : [],
          }
        : { maxAttempts: 1, baseDelayMs: 0, backoff: 'fixed' as const, retryableCodes: [] },
  }
  declarations.set(provider, declaration)
  return declaration
}

export function removeDeclaration(
  provider: string,
  declarations: Map<string, ProviderDeclaration>,
): boolean {
  if (!provider) return false
  return declarations.delete(provider)
}
