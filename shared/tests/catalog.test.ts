/**
 * 模型目录逻辑单测（P4 WS-3）—— parseModelIds / listModels（remote 成功 + 降级 static）。
 */
import { describe, expect, it } from 'vitest'
import { listModels, parseModelIds } from '../src/llm/catalog'

function withFetch(impl: typeof fetch) {
  return impl
}

const STATIC = ['fallback-a', 'fallback-b']

describe('parseModelIds', () => {
  it('{ data: [{id}] } → id 列表', () => {
    expect(parseModelIds({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })
  it('畸形 / 非数组 / 非对象 → 空数组（不抛）', () => {
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds('x')).toEqual([])
    expect(parseModelIds({ data: 'nope' })).toEqual([])
    expect(parseModelIds({ data: [{ nope: 1 }] })).toEqual([])
  })
})

describe('listModels', () => {
  it('remote 成功 → { models, source: remote }', async () => {
    const impl = withFetch(async () =>
      new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await listModels({ baseURL: 'https://x/v1', apiKey: 'k', staticModels: STATIC, fetchImpl: impl })
    expect(r).toEqual({ models: ['m1', 'm2'], source: 'remote' })
  })

  it('HTTP 非 2xx → 降级 static', async () => {
    const impl = withFetch(async () => new Response('err', { status: 500 })) as unknown as typeof fetch
    const r = await listModels({ baseURL: 'https://x/v1', apiKey: 'k', staticModels: STATIC, fetchImpl: impl })
    expect(r).toEqual({ models: STATIC, source: 'static' })
  })

  it('空列表 → 降级 static（避免空下拉）', async () => {
    const impl = withFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    const r = await listModels({ baseURL: 'https://x/v1', apiKey: 'k', staticModels: STATIC, fetchImpl: impl })
    expect(r).toEqual({ models: STATIC, source: 'static' })
  })

  it('fetch 抛错 / 超时 → 降级 static（不抛）', async () => {
    const boom = withFetch(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await listModels({ baseURL: 'https://x/v1', apiKey: 'k', staticModels: STATIC, fetchImpl: boom })).toEqual({
      models: STATIC,
      source: 'static',
    })
    const slow = withFetch((_i: any, init?: any) =>
      new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    ) as unknown as typeof fetch
    expect(await listModels({ baseURL: 'https://x/v1', apiKey: 'k', staticModels: STATIC, fetchImpl: slow, timeoutMs: 10 })).toEqual({
      models: STATIC,
      source: 'static',
    })
  })

  it('baseURL 去尾斜杠 → {base}/models', async () => {
    let seen = ''
    const impl = withFetch(async (input: any) => {
      seen = String(input)
      return new Response(JSON.stringify({ data: [{ id: 'z' }] }), { status: 200 })
    }) as unknown as typeof fetch
    await listModels({ baseURL: 'https://x/v1/', apiKey: 'k', staticModels: STATIC, fetchImpl: impl })
    expect(seen).toBe('https://x/v1/models')
  })
})
