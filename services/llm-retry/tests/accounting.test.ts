/**
 * llm-retry 单测（P2 WS-7）—— 纯逻辑直测（对齐项目策略）。
 *
 * 覆盖：registered 声明存表（ProviderDescriptor 归一）／unregistered 摘除／
 * finished 记账（usage 归一、未知 provider、无 usage 不记）／failed 记失败（error 归一、无 payload 兜底）。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderDescriptor, RetryPolicy, StreamError, Usage } from '@osteosome/shared'
import {
  recordFailure,
  recordUsage,
  removeDeclaration,
  upsertDeclaration,
  type ProviderDeclaration,
} from '../src/accounting'

const DESCRIPTOR: ProviderDescriptor = {
  provider: 'deepseek',
  defaultModel: 'deepseek-chat',
  credentialRef: 'env:DEEPSEEK_API_KEY',
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 500,
    backoff: 'exponential',
    retryableCodes: ['rate_limited', 'server_error'],
  },
}

function declarationsOf(...descriptors: ProviderDescriptor[]): Map<string, ProviderDeclaration> {
  const map = new Map<string, ProviderDeclaration>()
  for (const d of descriptors) upsertDeclaration(d as unknown as Record<string, unknown>, map)
  return map
}

describe('声明消费（llm.provider.registered / unregistered）', () => {
  it('registered → 存声明（provider → retryPolicy / defaultModel / credentialRef）', () => {
    const map = new Map<string, ProviderDeclaration>()
    const decl = upsertDeclaration(DESCRIPTOR as unknown as Record<string, unknown>, map)
    expect(decl).toEqual({
      provider: 'deepseek',
      defaultModel: 'deepseek-chat',
      credentialRef: 'env:DEEPSEEK_API_KEY',
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 500,
        backoff: 'exponential',
        retryableCodes: ['rate_limited', 'server_error'],
      },
    })
    expect(map.get('deepseek')?.retryPolicy.maxAttempts).toBe(3)
  })

  it('缺 provider / 畸形 retryPolicy 容错：不崩、字段兜底', () => {
    const map = new Map<string, ProviderDeclaration>()
    expect(upsertDeclaration({} as Record<string, unknown>, map)).toBeUndefined()
    const decl = upsertDeclaration(
      {
        provider: 'x',
        retryPolicy: { backoff: 'weird', retryableCodes: 'nope' },
      } as unknown as Record<string, unknown>,
      map,
    )
    expect(decl?.retryPolicy).toEqual({
      maxAttempts: 1,
      baseDelayMs: 0,
      backoff: 'fixed',
      retryableCodes: [],
    })
  })

  it('unregistered → 摘除声明', () => {
    const map = declarationsOf(DESCRIPTOR)
    expect(map.has('deepseek')).toBe(true)
    expect(removeDeclaration('deepseek', map)).toBe(true)
    expect(map.has('deepseek')).toBe(false)
    expect(removeDeclaration('', map)).toBe(false)
  })
})

describe('usage 记账（llm.request.finished → llm.metrics.usage）', () => {
  it('finished 带 usage → 归一 Usage 输出', () => {
    const map = declarationsOf(DESCRIPTOR)
    const record = recordUsage(
      {
        requestId: 'r1',
        provider: 'deepseek',
        finishReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 7 },
      } as Record<string, unknown>,
      map,
    )
    expect(record).toEqual({
      requestId: 'r1',
      provider: 'deepseek',
      usage: { promptTokens: 12, completionTokens: 7 },
      finishReason: 'stop',
    })
  })

  it('缺 requestId → 忽略；未知 provider → 记 unknown（不依赖声明表）', () => {
    const map = new Map<string, ProviderDeclaration>()
    expect(recordUsage({ provider: 'deepseek', finishReason: 'stop' } as Record<string, unknown>, map)).toBeUndefined()
    const record = recordUsage(
      { requestId: 'r2', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 0 } } as Record<string, unknown>,
      map,
    )
    expect(record?.provider).toBe('unknown')
  })

  it('usage 全 0 / 缺 usage → usage undefined（不产出 0-token 噪音行）', () => {
    const map = new Map<string, ProviderDeclaration>()
    const zero = recordUsage(
      { requestId: 'r3', provider: 'openai', finishReason: 'length', usage: { promptTokens: 0, completionTokens: 0 } } as Record<string, unknown>,
      map,
    )
    expect(zero?.usage).toBeUndefined()
    const none = recordUsage(
      { requestId: 'r4', provider: 'openai', finishReason: 'stop' } as Record<string, unknown>,
      map,
    )
    expect(none?.usage).toBeUndefined()
  })
})

describe('失败记账（llm.request.failed）', () => {
  it('failed 带 error → 归一 StreamError', () => {
    const map = new Map<string, ProviderDeclaration>()
    const error: StreamError = { code: 'rate_limited', message: 'slow down' }
    const record = recordFailure(
      { requestId: 'r5', provider: 'deepseek', error } as Record<string, unknown>,
      map,
    )
    expect(record).toEqual({ requestId: 'r5', provider: 'deepseek', error })
  })

  it('error 畸形 / 缺 requestId → 兜底或忽略', () => {
    const map = new Map<string, ProviderDeclaration>()
    const malformed = recordFailure(
      { requestId: 'r6', provider: 'deepseek', error: { code: 42 } } as unknown as Record<string, unknown>,
      map,
    )
    expect(malformed?.error).toEqual({ code: 'unknown', message: 'llm-retry: no error payload' })
    expect(recordFailure({ provider: 'x' } as Record<string, unknown>, map)).toBeUndefined()
  })
})
