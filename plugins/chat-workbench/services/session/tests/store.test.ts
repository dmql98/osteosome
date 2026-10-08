/**
 * session store 单测（P3-1 / 阶段 F M2）—— SQLite 版（CRUD / append-only / 列级更新 / 持久化 / 预览）。
 *
 * 与 JSONL 版的差别：断言从「文件形状」（`.jsonl` / `index.json` / `.tmp`）改为「读回内容」。
 * 旧格式迁移、原子 rename 那些用例随 JSONL 代码一并删除（见详细计划 §0.3）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, cleanMessagePreview } from '../src/store'

let dir: string
const stores: SessionStore[] = []

/** 打开一个 store 并登记，保证 afterEach 能关掉（Windows 下不关文件句柄删不掉目录）。 */
function makeStore(dataDir: string = dir): SessionStore {
  const s = new SessionStore(dataDir)
  stores.push(s)
  return s
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-session-'))
})
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  rmSync(dir, { recursive: true, force: true })
})

const dbFile = () => join(dir, 'sessions.db')

describe('SessionStore（SQLite）', () => {
  it('create：生成 id/默认标题，库文件落盘', () => {
    const store = makeStore()
    const meta = store.create()
    expect(meta.id).toMatch(/^s_/)
    expect(meta.title).toBe('新会话')
    expect(store.list().map((m) => m.id)).toEqual([meta.id])
    expect(readdirSync(dir)).toContain('sessions.db')
  })

  it('create：自定义标题（非空才用）', () => {
    const store = makeStore()
    expect(store.create('我的会话').title).toBe('我的会话')
    expect(store.create('   ').title).toBe('新会话')
  })

  it('appendMessage：只增不改（顺序即 seq）', () => {
    const store = makeStore()
    const { id } = store.create('c')
    const m1 = store.appendMessage(id, { role: 'user', content: '你好' })!
    const m2 = store.appendMessage(id, { role: 'assistant', content: '你好，有什么可以帮您' })!
    expect(m1.id).toMatch(/^m_/)
    expect(m2.id).not.toBe(m1.id)
    const file = store.get(id)!
    expect(file.messages.map((m) => m.content)).toEqual(['你好', '你好，有什么可以帮您'])
    expect(file.messages[0].id).toBe(m1.id)
  })

  it('appendMessage：带 finishReason/usage/自定义 id', () => {
    const store = makeStore()
    const { id } = store.create()
    const m = store.appendMessage(id, {
      role: 'assistant',
      content: '答案',
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 5 },
      id: 'm_custom',
    })!
    expect(m).toMatchObject({
      id: 'm_custom',
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 5 },
    })
  })

  it('rename：改标题 + updatedAt 刷新，但**消息一条不动**', () => {
    const store = makeStore()
    const { id } = store.create('旧名')
    store.appendMessage(id, { role: 'user', content: 'a' })
    store.appendMessage(id, { role: 'assistant', content: 'b' })
    const before = store.get(id)!.messages

    const meta = store.rename(id, '新名')!
    expect(meta.title).toBe('新名')
    expect(store.get(id)!.meta.title).toBe('新名')
    expect(store.list().find((m) => m.id === id)!.title).toBe('新名')
    // 列级 UPDATE：消息逐条不变、条数不变（JSONL 会重写全文）
    expect(store.get(id)!.messages).toEqual(before)
    expect(store.rename('nope', 'x')).toBeNull()
  })

  it('remove：删会话连带删消息，返回 true；不存在 false', () => {
    const store = makeStore()
    const { id } = store.create()
    store.appendMessage(id, { role: 'user', content: 'x' })
    expect(store.remove(id)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.get(id)).toBeNull()
    expect(store.remove(id)).toBe(false)
  })

  it('clear：清空全部，返回删除数量', () => {
    const store = makeStore()
    store.create('a')
    store.create('b')
    store.create('c')
    expect(store.clear()).toBe(3)
    expect(store.list()).toEqual([])
    expect(store.ids().size).toBe(0)
  })

  it('appendMessage：会话不存在 → null（不抛）', () => {
    const store = makeStore()
    expect(store.appendMessage('nope', { role: 'user', content: 'x' })).toBeNull()
  })

  it('持久化：重开同一 dataDir，数据仍在（无缓存也读得到）', () => {
    const store = makeStore()
    const { id } = store.create('持久')
    store.appendMessage(id, { role: 'user', content: 'hi' })
    store.close()
    stores.length = 0

    const store2 = makeStore()
    expect(store2.list().map((m) => m.id)).toEqual([id])
    expect(store2.get(id)!.messages.map((m) => m.content)).toEqual(['hi'])
  })

  it('不产生任何 JSONL / index.json 文件', () => {
    const store = makeStore()
    const { id } = store.create()
    store.appendMessage(id, { role: 'user', content: 'x' })
    const names = readdirSync(dir)
    expect(names.some((f) => f.endsWith('.jsonl') || f.endsWith('.json'))).toBe(false)
    expect(names).toContain('sessions.db')
  })

  it('append 后索引 updatedAt 与消息 createdAt 一致', () => {
    const store = makeStore()
    const { id } = store.create()
    const m = store.appendMessage(id, { role: 'user', content: 'x' })!
    expect(store.get(id)!.meta.updatedAt).toBe(m.createdAt)
    expect(store.list().find((x) => x.id === id)!.updatedAt).toBe(m.createdAt)
  })
})

describe('S4 / P2 字段', () => {
  it('reasoning 落库后仍在，且 content 不含它', () => {
    const store = makeStore()
    const { id } = store.create()
    const m = store.appendMessage(id, { role: 'assistant', content: '答', reasoning: '先想…' })!
    expect(m.reasoning).toBe('先想…')
    expect(store.get(id)!.messages[0].reasoning).toBe('先想…')
  })

  it('toolCalls / toolCallId / toolName 落库并读回（JSON 文本列）', () => {
    const store = makeStore()
    const { id } = store.create()
    store.appendMessage(id, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
    })
    store.appendMessage(id, { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'read' })
    const msgs = store.get(id)!.messages
    expect(msgs[0].toolCalls).toEqual([{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }])
    expect(msgs[1]).toMatchObject({ toolCallId: 'c1', toolName: 'read' })
  })

  it('setPinned：置顶生效且**不改 updatedAt**（否则会话会跳进「今天」）', () => {
    const store = makeStore()
    const { id } = store.create('a')
    const before = store.list().find((m) => m.id === id)!.updatedAt
    const meta = store.setPinned(id, true)!
    expect(meta.pinned).toBe(true)
    expect(meta.updatedAt).toBe(before)
    expect(store.setPinned(id, false)!.pinned).toBeUndefined()
    expect(store.setPinned('nope', true)).toBeNull()
  })

  it('setArchived：归档生效且不改 updatedAt', () => {
    const store = makeStore()
    const { id } = store.create('a')
    const before = store.list().find((m) => m.id === id)!.updatedAt
    const meta = store.setArchived(id, true)!
    expect(meta.archived).toBe(true)
    expect(meta.updatedAt).toBe(before)
    expect(store.setArchived(id, false)!.archived).toBeUndefined()
  })

  it('setWorkspace：合并式，且不改 updatedAt', () => {
    const store = makeStore()
    const { id } = store.create('a')
    const before = store.list().find((m) => m.id === id)!.updatedAt
    store.setWorkspace(id, { workspace: 'C:\\proj' })
    store.setWorkspace(id, { addRoot: 'D:\\data' })
    let meta = store.list().find((m) => m.id === id)!
    expect(meta.workspace).toBe('C:\\proj')
    expect(meta.workspaces).toEqual(['D:\\data'])
    store.setWorkspace(id, { removeRoot: 'D:\\data' })
    meta = store.list().find((m) => m.id === id)!
    expect(meta.workspaces).toBeUndefined()
    expect(meta.updatedAt).toBe(before)
    expect(store.setWorkspace('nope', { workspace: 'x' })).toBeNull()
  })

  it('lastMessage：append user/assistant 时更新预览；tool 不更新', () => {
    const store = makeStore()
    const { id } = store.create()
    store.appendMessage(id, { role: 'assistant', content: '最后一条回答' })
    expect(store.list().find((m) => m.id === id)!.lastMessage).toBe('最后一条回答')
    store.appendMessage(id, { role: 'tool', content: '{"huge":"json"}' })
    expect(store.list().find((m) => m.id === id)!.lastMessage).toBe('最后一条回答')
  })

  it('create(parentId)：子会话带 parentId 落库并持久化', () => {
    const store = makeStore()
    const parent = store.create('父')
    const child = store.create('子', parent.id)
    expect(child.parentId).toBe(parent.id)
    store.close()
    stores.length = 0
    const store2 = makeStore()
    expect(store2.list().find((m) => m.id === child.id)!.parentId).toBe(parent.id)
    expect(store2.list().find((m) => m.id === parent.id)!.parentId).toBeUndefined()
  })

  it('cleanMessagePreview：去控制字符 / 压空白 / 截 120 码点', () => {
    expect(cleanMessagePreview('  a\t\tb\n c ')).toBe('a b c')
    expect(Array.from(cleanMessagePreview('x'.repeat(200))).length).toBe(120)
    const emoji = '😀'.repeat(130)
    expect(Array.from(cleanMessagePreview(emoji)).length).toBe(120)
  })
})

describe('getPage：游标分页（M3）', () => {
  function seed(store: SessionStore): string {
    const { id } = store.create('paged')
    for (let i = 0; i < 5; i += 1) store.appendMessage(id, { role: 'user', content: `m${i}` })
    return id
  }

  it('缺省取最新一页，升序返回，hasMore/nextCursor/total 正确', () => {
    const store = makeStore()
    const id = seed(store)
    const r = store.getPage(id, { limit: 2 })!
    expect(r.file.messages.map((m) => m.content)).toEqual(['m3', 'm4'])
    expect(r.page).toEqual({ hasMore: true, nextCursor: '4', total: 5 })
  })

  it('before=nextCursor 取更早一页；到底时 hasMore=false、nextCursor=null', () => {
    const store = makeStore()
    const id = seed(store)
    const p1 = store.getPage(id, { limit: 2 })!
    const p2 = store.getPage(id, { limit: 2, before: p1.page.nextCursor! })!
    expect(p2.file.messages.map((m) => m.content)).toEqual(['m1', 'm2'])
    expect(p2.page).toEqual({ hasMore: true, nextCursor: '2', total: 5 })
    const p3 = store.getPage(id, { limit: 2, before: p2.page.nextCursor! })!
    expect(p3.file.messages.map((m) => m.content)).toEqual(['m0'])
    expect(p3.page).toEqual({ hasMore: false, nextCursor: null, total: 5 })
  })

  it('翻页拼回 = 全量', () => {
    const store = makeStore()
    const id = seed(store)
    const all = store.get(id)!.messages.map((m) => m.content)
    const collected: string[] = []
    let before: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const r = store.getPage(id, { limit: 2, ...(before ? { before } : {}) })!
      collected.unshift(...r.file.messages.map((m) => m.content))
      if (!r.page.hasMore || !r.page.nextCursor) break
      before = r.page.nextCursor
    }
    expect(collected).toEqual(all)
  })

  it('空会话 → 空页、无游标；不存在会话 → null', () => {
    const store = makeStore()
    const { id } = store.create()
    const r = store.getPage(id, { limit: 10 })!
    expect(r.file.messages).toEqual([])
    expect(r.page).toEqual({ hasMore: false, nextCursor: null, total: 0 })
    expect(store.getPage('nope', { limit: 10 })).toBeNull()
  })
})

describe('性能：append 成本与消息数无关', () => {
  it('撑到 ~600 条后 append 仍与早期同量级', { timeout: 30_000 }, () => {
    const store = makeStore()
    const { id } = store.create()
    const big = 'x'.repeat(3000)
    const time = (fn: () => void): number => {
      const s = performance.now()
      fn()
      return performance.now() - s
    }
    store.appendMessage(id, { role: 'user', content: big })
    const early = time(() => {
      for (let i = 0; i < 20; i++) store.appendMessage(id, { role: 'assistant', content: big })
    }) / 20
    for (let i = 0; i < 560; i++) store.appendMessage(id, { role: 'assistant', content: big })
    const late = time(() => {
      for (let i = 0; i < 20; i++) store.appendMessage(id, { role: 'assistant', content: big })
    }) / 20
    // 全量重写会随消息数线性涨；INSERT + 索引应基本持平
    expect(late).toBeLessThan(early * 6 + 3)
  })
})
