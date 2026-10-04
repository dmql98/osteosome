/**
 * llm-retry 单测（P2 WS-7）—— 纯逻辑直测（对齐项目策略）。
 *
 * 覆盖：registered 声明存表（ProviderDescriptor 归一）／unregistered 摘除／
 * requestId→provider 映射（started 记，供 finished 记账回填——契约里 finished 不带 provider）／
 * finished 记账（usage 归一、provider 回填、无 usage 不记）／failed 记失败（error 归一、畸形兜底）。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderDescriptor, StreamError } from '@osteosome/shared'
import {
  recordFailure,
  recordUsage,
  rememberRequestProvider,
  removeDeclaration,
  upsertDeclaration,
  type ProviderByRequest,
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

describe('requestId → provider 映射（llm.request.started）', () => {
  it('started 记映射；畸形 payload 忽略', () => {
    const reqs: ProviderByRequest = new Map()
    rememberRequestProvider({ requestId: 'r1', provider: 'openai', model: 'gpt-4o-mini' }, reqs)
    expect(reqs.get('r1')).toBe('openai')
    rememberRequestProvider({ requestId: 'r2' } as Record<string, unknown>, reqs)
    expect(reqs.has('r2')).toBe(false)
  })
})

describe('usage 记账（llm.request.finished → llm.metrics.usage）', () => {
  it('finished 不带 provider → 由 started 映射回填（本服务存在理由）', () => {
    const map = declarationsOf(DESCRIPTOR)
    const reqs: ProviderByRequest = new Map()
    rememberRequestProvider({ requestId: 'r1', provider: 'openai' }, reqs)
    // finished 契约里没有 provider 字段——靠映射回填，否则记账 provider 恒为 unknown
    const record = recordUsage(
      {
        requestId: 'r1',
        finishReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 7 },
      } as Record<string, unknown>,
      map,
      reqs,
    )
    expect(record).toEqual({
      requestId: 'r1',
      provider: 'openai',
      usage: { promptTokens: 12, completionTokens: 7 },
      finishReason: 'stop',
    })
  })

  it('finished 自带 provider 时优先用自带值', () => {
    const map = new Map<string, ProviderDeclaration>()
    const reqs: ProviderByRequest = new Map([['r1', 'openai']])
    const record = recordUsage(
      { requestId: 'r1', provider: 'deepseek', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } } as Record<string, unknown>,
      map,
      reqs,
    )
    expect(record?.provider).toBe('deepseek')
  })

  it('缺 requestId → 忽略；无映射且无 provider → 记 unknown', () => {
    const map = new Map<string, ProviderDeclaration>()
    const reqs: ProviderByRequest = new Map()
    expect(recordUsage({ provider: 'deepseek', finishReason: 'stop' } as Record<string, unknown>, map, reqs)).toBeUndefined()
    const record = recordUsage(
      { requestId: 'r2', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 0 } } as Record<string, unknown>,
      map,
      reqs,
    )
    expect(record?.provider).toBe('unknown')
  })

  it('usage 全 0 / 缺 usage → usage undefined（不产出 0-token 噪音行）', () => {
    const map = new Map<string, ProviderDeclaration>()
    const reqs: ProviderByRequest = new Map()
    const zero = recordUsage(
      { requestId: 'r3', provider: 'openai', finishReason: 'length', usage: { promptTokens: 0, completionTokens: 0 } } as Record<string, unknown>,
      map,
      reqs,
    )
    expect(zero?.usage).toBeUndefined()
    const none = recordUsage(
      { requestId: 'r4', provider: 'openai', finishReason: 'stop' } as Record<string, unknown>,
      map,
      reqs,
    )
    expect(none?.usage).toBeUndefined()
  })
})

describe('失败记账（llm.request.failed）', () => {
  it('failed 带 error → 归一 StreamError（provider 同样靠映射回填）', () => {
    const map = new Map<string, ProviderDeclaration>()
    const reqs: ProviderByRequest = new Map([['r5', 'openai']])
    const error: StreamError = { code: 'rate_limited', message: 'slow down' }
    const record = recordFailure(
      { requestId: 'r5', error } as Record<string, unknown>,
      map,
      reqs,
    )
    expect(record).toEqual({ requestId: 'r5', provider: 'openai', error })
  })

  it('error 畸形 / 缺 requestId → 兜底或忽略', () => {
    const map = new Map<string, ProviderDeclaration>()
    const reqs: ProviderByRequest = new Map()
    const malformed = recordFailure(
      { requestId: 'r6', provider: 'deepseek', error: { code: 42 } } as unknown as Record<string, unknown>,
      map,
      reqs,
    )
    expect(malformed?.error).toEqual({ code: 'unknown', message: 'llm-retry: no error payload' })
    expect(recordFailure({ provider: 'x' } as Record<string, unknown>, map, reqs)).toBeUndefined()
  })
})
