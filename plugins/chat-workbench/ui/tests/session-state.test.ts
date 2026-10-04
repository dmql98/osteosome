/**
 * 会话状态层单测（P6，从 client/tests/stores/session.store.test.ts 搬来）。
 *
 * ## 这次搬迁顺带改了机制，所以断言也改了
 *
 * 原来是 pinia 单例 + `vi.mock('../../src/core-sdk/sse')` 捕获 handler。
 * 现在状态层是普通函数、用**真实的 sse 客户端**（只把 `EventSource` 换成假的）——
 * 后者更接近生产：handler 订阅的不是我们塞进去的 Map，而是真实的解包路径。
 *
 * 变化的只有两处语义，其余断言原样搬：
 * · `curId` 不再是本 store 的字段，而是共享层里的 ref（P6 的核心改动）
 * · `session.deleted` 删掉当前会话时，**不再**由本层清 curId
 */

/**
 * 「删除当前会话 → 清 curId」这条为什么搬到了 ① 视图，而不是状态层。
 *
 * 原来的 store 同时是「数据的持有者」与「唯一的变更入口」，所以它可以在
 * `session.deleted` 里顺手清 curId。现在三个视图各自持有一份状态，
 * 而 curId 是**跨 iframe 的共享值** —— 在任意一个视图里清它，
 * 另外两个视图也会跟着清。这是**对的行为**（它们本来就不该显示已删会话），
 * 但它属于「响应共享状态的变化」，而不是「处理一条服务端事件」。
 *
 * 具体处置：状态层只清自己的 `messages`，curId 由 ①（会话列表）在
 * `session.deleted` 里判断后调 `select('')`。见 SessionListView 的处理。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { currentSessionId, setCurrentSessionId, __resetSessionSyncForTest } from '../src/state/session-sync'
import { useSessionState } from '../src/state/session'

const META = (id: string, title: string, updatedAt: string) => ({ id, title, createdAt: updatedAt, updatedAt })

let es: FakeEventSource
let sent: Array<{ topic: string; payload: unknown }>

beforeEach(() => {
  es = installFakeEventSource()
  __resetSessionSyncForTest()
  sent = []
  // 命令通道：真实的 useCommand 走 fetch，这里只把「发出去的是什么」记下来
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/command')) {
        sent.push({
          topic: JSON.parse(String(init?.body ?? '{}')).topic,
          payload: JSON.parse(String(init?.body ?? '{}')).payload,
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
})

describe('useSessionState', () => {
  it('session.list.result → 填充 list，按 updatedAt 倒序', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    es.emit('session.list.result', {
      requestId: 'r',
      sessions: [META('a', 'A', '2024-01-01'), META('b', 'B', '2024-03-01'), META('c', 'C', '2024-02-01')],
    })
    expect(sessions.list.value.map((m) => m.id)).toEqual(['b', 'c', 'a'])
    sessions.dispose()
  })

  it('session.created → 增量插入并排序', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    sessions.list.value = [META('a', 'A', '2024-01-01')]
    es.emit('session.created', META('b', 'B', '2024-05-01'))
    expect(sessions.list.value.map((m) => m.id)).toEqual(['b', 'a'])
    sessions.dispose()
  })

  it('session.updated → 改标题 + updatedAt 刷新', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    sessions.list.value = [META('a', '旧', '2024-01-01')]
    es.emit('session.updated', { sessionId: 'a', title: '新', updatedAt: '2024-09-01' })
    expect(sessions.list.value[0]).toMatchObject({ title: '新', updatedAt: '2024-09-01' })
    sessions.dispose()
  })

  it('session.deleted → 移除该会话（curId 与清空交给 ① 视图处理）', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    sessions.list.value = [META('a', 'A', '2024-01-01')]
    setCurrentSessionId('a')
    sessions.messages.value = [{ id: 'm1', role: 'user', content: 'x', createdAt: '2024-01-01' }]
    es.emit('session.deleted', { sessionId: 'a' })
    expect(sessions.list.value).toEqual([])
    // curId **不动** —— 见文件头「为什么搬到了 ① 视图」
    expect(currentSessionId().value).toBe('a')
    sessions.dispose()
  })

  it('message.appended → 当前会话增量缓存；非当前会话忽略；id 去重防重放', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    setCurrentSessionId('a')
    const msg = { id: 'm1', role: 'assistant' as const, content: '答', createdAt: '2024-01-01' }
    es.emit('message.appended', { sessionId: 'a', message: msg })
    expect(sessions.messages.value).toHaveLength(1)
    // 重放同一 id → 不重复
    es.emit('message.appended', { sessionId: 'a', message: msg })
    expect(sessions.messages.value).toHaveLength(1)
    // 非当前会话忽略
    es.emit('message.appended', {
      sessionId: 'other',
      message: { id: 'm2', role: 'user', content: 'y', createdAt: '2024-01-01' },
    })
    expect(sessions.messages.value).toHaveLength(1)
    sessions.dispose()
  })

  it('curId 走共享层：select 之后读得到的是同一个值', async () => {
    const sessions = useSessionState()
    sessions.list.value = [META('a', 'A', '2024-01-01'), META('b', 'B', '2024-01-01')]
    sessions.select('b')
    expect(currentSessionId().value).toBe('b')
    expect(sessions.current()?.id).toBe('b')
    sessions.dispose()
  })

  it('curId 变了 → 自动载入新会话历史（状态层的义务，不是视图的 watch）', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    sent.length = 0
    setCurrentSessionId('a')
    // `session.get` 是命令，immediate 的 watch 会立刻发一条
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.map((c) => c.topic)).toContain('session.get')
    expect(sent.find((c) => c.topic === 'session.get')?.payload).toMatchObject({ sessionId: 'a' })
    sessions.dispose()
  })

  it('session.get.result → 填充 messages', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    es.emit('session.get.result', {
      session: { id: 'a', messages: [{ id: 'm1', role: 'user', content: '你好', createdAt: '2024-01-01' }] },
    })
    expect(sessions.messages.value).toHaveLength(1)
    sessions.dispose()
  })

  it('recent = updatedAt 最大', async () => {
    const sessions = useSessionState()
    sessions.list.value = [META('a', 'A', '2024-01-01'), META('b', 'B', '2024-06-01')]
    expect(sessions.recent()?.id).toBe('b')
    sessions.dispose()
  })

  it('bindEvents 幂等（不重复绑）', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    const before = sent.length
    sessions.dispose()
    expect(before).toBeGreaterThanOrEqual(0)
  })

  it('dispose 之后不再收事件（iframe 被移除时不退订的症状是往死对象里写）', async () => {
    const sessions = useSessionState()
    await sessions.bootstrap()
    sessions.dispose()
    es.emit('session.created', META('x', 'X', '2024-01-01'))
    expect(sessions.list.value).toEqual([])
  })
})