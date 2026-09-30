/**
 * retry 执行器纯逻辑（P4 WS-2）—— 读 provider 声明的 RetryPolicy，决定是否重发 `llm.request`。
 *
 * 判定三条（P4 计划 §WS-2）：
 * 1. `error.code ∈ retryableCodes` 才重试（401/missing_credential 等非瞬态直接失败）；
 * 2. `maxAttempts` 上限（含首次；超限不再重试）；
 * 3. **首块到达前**的失败才重试——流已中断不自动续（首块已出 → 直接 finish{error} 上抛给用户）。
 *
 * 退避：`baseDelayMs * 2^(attempt-1) + jitter`（exponential）；fixed 则不加指数。
 * `jitter` 注入以便单测确定性（默认实现全抖动）。
 */
import type { RetryPolicy, StreamError } from '@osteosome/shared'

export interface RetryDecision {
  /** 是否重试 */
  retry: boolean
  /** 重试原因（非重试时用于日志/排查） */
  reason: 'ok' | 'not_retryable' | 'max_attempts' | 'stream_started' | 'no_policy'
  /** 退避毫秒（retry=true 时有效） */
  delayMs: number
  /** 已尝试次数（含本次失败的那次） */
  attempts: number
}

/** 默认抖动：0~delayMs 全抖动，避免多客户端同时重试打爆上游 */
export function defaultJitter(delayMs: number, random: () => number = Math.random): number {
  return Math.floor(delayMs * random())
}

/**
 * 计算退避：exponential = base * 2^(attempt-1) + jitter；fixed = base + jitter。
 * attempt 从 1 起（第一次重试）。
 */
export function computeDelay(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1)
  const raw = policy.backoff === 'exponential' ? policy.baseDelayMs * 2 ** exponent : policy.baseDelayMs
  return raw + defaultJitter(raw, random)
}

export interface ShouldRetryInput {
  /** 声明的 RetryPolicy（provider 未注册 → undefined） */
  policy: RetryPolicy | undefined
  /** 本次失败（含）已尝试次数 */
  attempts: number
  /** 该请求是否已出过首块（流已开始） */
  streamed: boolean
  error: StreamError
  random?: () => number
}

export function shouldRetry(input: ShouldRetryInput): RetryDecision {
  const { policy, attempts, streamed, error, random } = input

  if (!policy) {
    return { retry: false, reason: 'no_policy', delayMs: 0, attempts }
  }
  if (!policy.retryableCodes.includes(error.code)) {
    return { retry: false, reason: 'not_retryable', delayMs: 0, attempts }
  }
  if (attempts >= policy.maxAttempts) {
    return { retry: false, reason: 'max_attempts', delayMs: 0, attempts }
  }
  if (streamed) {
    // 首块已出——流已中断，不自动续（P4 计划 §6）
    return { retry: false, reason: 'stream_started', delayMs: 0, attempts }
  }
  // 下一次尝试的序号 = 当前次数 + 1
  return { retry: true, reason: 'ok', delayMs: computeDelay(policy, attempts + 1, random), attempts }
}
