/**
 * retry 执行器单测（P4 WS-2）—— 纯逻辑直测（对齐项目策略）。
 *
 * 覆盖：瞬态错误退避重试到上限 / 非瞬态（401/missing_credential）立即失败 / exponential+fixed 退避窗口 /
 * 首块后失败不重试 / 流中断不续 / jitter 确定性注入。
 */
import { describe, expect, it } from 'vitest'
import type { RetryPolicy } from '@osteosome/shared'
import { computeDelay, shouldRetry, defaultJitter } from '../src/retry/engine'

const EXP: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  backoff: 'exponential',
  retryableCodes: ['rate_limited', 'server_error', 'network'],
}
const FIXED: RetryPolicy = { ...EXP, backoff: 'fixed' }
// 确定性 jitter：固定 0（random()=0 → jitter=0）
const NO_JITTER = () => 0
const HALF = () => 0.5

describe('shouldRetry 判定', () => {
  it('瞬态错误（rate_limited）→ 重试，指数退避（第 2 次尝试 = base*2^1）', () => {
    const d = shouldRetry({ policy: EXP, attempts: 1, streamed: false, error: { code: 'rate_limited', message: '' }, random: NO_JITTER })
    expect(d.retry).toBe(true)
    expect(d.reason).toBe('ok')
    expect(d.delayMs).toBe(200) // 第 1 次失败 → 退避到第 2 次尝试 = base * 2^1
  })

  it('非瞬态（401 unauthorized）→ 立即失败，不重试', () => {
    const d = shouldRetry({ policy: EXP, attempts: 1, streamed: false, error: { code: 'unauthorized', message: '' }, random: NO_JITTER })
    expect(d.retry).toBe(false)
    expect(d.reason).toBe('not_retryable')
  })

  it('missing_credential → 立即失败（不在 retryableCodes）', () => {
    const d = shouldRetry({ policy: EXP, attempts: 1, streamed: false, error: { code: 'missing_credential', message: '' }, random: NO_JITTER })
    expect(d.retry).toBe(false)
    expect(d.reason).toBe('not_retryable')
  })

  it('达到 maxAttempts → 不再重试', () => {
    // attempts=3 = maxAttempts=3
    const d = shouldRetry({ policy: EXP, attempts: 3, streamed: false, error: { code: 'rate_limited', message: '' }, random: NO_JITTER })
    expect(d.retry).toBe(false)
    expect(d.reason).toBe('max_attempts')
  })

  it('首块已出（streamed）→ 不重试（流中断不续）', () => {
    const d = shouldRetry({ policy: EXP, attempts: 1, streamed: true, error: { code: 'network', message: '' }, random: NO_JITTER })
    expect(d.retry).toBe(false)
    expect(d.reason).toBe('stream_started')
  })

  it('无声明（provider 未注册）→ 不重试', () => {
    const d = shouldRetry({ policy: undefined, attempts: 1, streamed: false, error: { code: 'rate_limited', message: '' } })
    expect(d.retry).toBe(false)
    expect(d.reason).toBe('no_policy')
  })
})

describe('computeDelay 退避', () => {
  it('exponential：base * 2^(attempt-1)', () => {
    expect(computeDelay(EXP, 1, NO_JITTER)).toBe(100)
    expect(computeDelay(EXP, 2, NO_JITTER)).toBe(200)
    expect(computeDelay(EXP, 3, NO_JITTER)).toBe(400)
  })

  it('fixed：恒为 base（不加指数）', () => {
    expect(computeDelay(FIXED, 1, NO_JITTER)).toBe(100)
    expect(computeDelay(FIXED, 3, NO_JITTER)).toBe(100)
  })

  it('jitter 注入：0.5 → 加半档（窗口内）', () => {
    expect(computeDelay(EXP, 1, HALF)).toBe(150) // 100 + 50
  })

  it('defaultJitter 在 [0, delay) 区间', () => {
    expect(defaultJitter(100, () => 0)).toBe(0)
    expect(defaultJitter(100, () => 0.99)).toBe(99)
  })
})
