/**
 * session store 单测（P3 WS-4）—— mock sse 捕获 handler（等同跨窗事件注入），
 * 验证 list 排序 / curId 本地态 / 事件驱动刷新 / message.appended 增量。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const sseHandlers = new Map<string, (payload: unknown) => void>()

vi.mock('../../src/core-sdk/sse', async () => {
  const actual = await vi.importActual<typeof import('../../src/core-sdk/sse')>('../../src/core-sdk/sse')
  return {
    ...actual,
    sse: {
      subscribe: vi.fn((topic: string, handler: (payload: unknown) => void) => {
        sseHandlers.set(topic, handler)
        return () => sseHandlers.delete(topic)
      }),
      ensureConnected: vi.fn(),
    },
  }
})

import { useSessionStore } from '../../src/stores/session.store'

const META = (id: string, title: string, updatedAt: string) => ({ id, title, createdAt: updatedAt, updatedAt })

beforeEach(() => {
  sseHandlers.clear()
  setActivePinia(createPinia())
})

describe('session store', () => {
  it('session.list.result → 填充 list，按 updatedAt 倒序', () => {
    const store = useSessionStore()
    store.bindEvents()
    sseHandlers.get('session.list.result')!({
      requestId: 'r',
      sessions: [META('a', 'A', '2024-01-01'), META('b', 'B', '2024-03-01'), META('c', 'C', '2024-02-01')],
    })
    expect(store.list.map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('session.created → 增量插入并排序', () => {
    const store = useSessionStore()
    store.bindEvents()
    store.list = [META('a', 'A', '2024-01-01')]
    sseHandlers.get('session.created')!(META('b', 'B', '2024-05-01'))
    expect(store.list.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('session.updated → 改标题 + updatedAt 刷新', () => {
    const store = useSessionStore()
    store.bindEvents()
    store.list = [META('a', '旧', '2024-01-01')]
    sseHandlers.get('session.updated')!({ sessionId: 'a', title: '新', updatedAt: '2024-09-01' })
    expect(store.list[0]).toMatchObject({ title: '新', updatedAt: '2024-09-01' })
  })

  it('session.deleted → 移除；删当前会话清 curId + messages', () => {
    const store = useSessionStore()
    store.bindEvents()
    store.list = [META('a', 'A', '2024-01-01')]
    store.select('a')
    store.messages = [{ id: 'm1', role: 'user', content: 'x', createdAt: '2024-01-01' }]
    sseHandlers.get('session.deleted')!({ sessionId: 'a' })
    expect(store.list).toEqual([])
    expect(store.curId).toBe('')
    expect(store.messages).toEqual([])
  })

  it('message.appended → 当前会话增量缓存；非当前会话忽略；id 去重防重放', () => {
    const store = useSessionStore()
    store.bindEvents()
    store.select('a')
    const msg = { id: 'm1', role: 'assistant' as const, content: '答', createdAt: '2024-01-01' }
    sseHandlers.get('message.appended')!({ sessionId: 'a', message: msg })
    expect(store.messages).toHaveLength(1)
    // 重放同一 id → 不重复
    sseHandlers.get('message.appended')!({ sessionId: 'a', message: msg })
    expect(store.messages).toHaveLength(1)
    // 非当前会话忽略
    sseHandlers.get('message.appended')!({ sessionId: 'other', message: { id: 'm2', role: 'user', content: 'y', createdAt: '2024-01-01' } })
    expect(store.messages).toHaveLength(1)
  })

  it('curId 本地态：select 只影响本 store（不跨窗）', () => {
    const store = useSessionStore()
    store.list = [META('a', 'A', '2024-01-01'), META('b', 'B', '2024-01-01')]
    store.select('b')
    expect(store.curId).toBe('b')
    setActivePinia(createPinia())
    const other = useSessionStore()
    expect(other.curId).toBe('')
  })

  it('recent getter = updatedAt 最大', () => {
    const store = useSessionStore()
    store.list = [META('a', 'A', '2024-01-01'), META('b', 'B', '2024-06-01')]
    expect(store.recent?.id).toBe('b')
  })

  it('bindEvents 幂等（不重复绑）', () => {
    const store = useSessionStore()
    store.bindEvents()
    const first = sseHandlers.get('session.created')
    store.bindEvents()
    expect(sseHandlers.get('session.created')).toBe(first)
  })
})
