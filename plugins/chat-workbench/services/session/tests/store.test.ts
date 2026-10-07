/**
 * session store 单测（P3 WS-1；P4b P1 修订）—— CRUD / append-only / 原子写 / 损坏降级 / 对账 / JSONL。
 *
 * P1-6 后会话文件是 `.jsonl`（首行 meta、其余每行一条 message），不再是单个 `.json`。
 * P1-3 后启动会对账：索引坏 → 从目录恢复（不再是「退化为空」）—— **这是本次唯一改既有期望值的地方**。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, cleanMessagePreview } from '../src/store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-session-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sessionsDir = () => join(dir, 'sessions')

describe('SessionStore', () => {
  it('create：生成 id/默认标题，索引 + JSONL 双写一致', () => {
    const store = new SessionStore(dir)
    const meta = store.create()
    expect(meta.id).toMatch(/^s_/)
    expect(meta.title).toBe('新会话')
    expect(store.list().map((m) => m.id)).toEqual([meta.id])
    const file = join(sessionsDir(), `${meta.id}.jsonl`)
    expect(existsSync(file)).toBe(true)
    // JSONL：首行 meta，无消息行
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]) as { id: string }).id).toBe(meta.id)
  })

  it('create：自定义标题（非空才用）', () => {
    const store = new SessionStore(dir)
    expect(store.create('我的会话').title).toBe('我的会话')
    expect(store.create('   ').title).toBe('新会话')
  })

  it('appendMessage：只增不改（append-only）', () => {
    const store = new SessionStore(dir)
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
    const store = new SessionStore(dir)
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

  it('rename：改标题 + updatedAt 刷新，索引同步（不再重写全文）', () => {
    const store = new SessionStore(dir)
    const { id } = store.create('旧名')
    const before = readFileSync(join(sessionsDir(), `${id}.jsonl`), 'utf8')
    const meta = store.rename(id, '新名')!
    expect(meta.title).toBe('新名')
    expect(store.get(id)!.meta.title).toBe('新名')
    expect(store.list().find((m) => m.id === id)!.title).toBe('新名')
    // rename 只动索引：全文一字未改（P1-6 的 O(1) 前提）
    expect(readFileSync(join(sessionsDir(), `${id}.jsonl`), 'utf8')).toBe(before)
    expect(store.rename('nope', 'x')).toBeNull()
  })

  it('remove：删索引 + 删全文，返回 true；不存在 false', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    const file = join(sessionsDir(), `${id}.jsonl`)
    expect(existsSync(file)).toBe(true)
    expect(store.remove(id)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(store.list()).toEqual([])
    expect(store.remove(id)).toBe(false)
  })

  it('clear：清空全部，返回删除数量', () => {
    const store = new SessionStore(dir)
    store.create('a')
    store.create('b')
    store.create('c')
    expect(store.clear()).toBe(3)
    expect(store.list()).toEqual([])
    const files = readdirSync(sessionsDir()).filter((f) => f.endsWith('.jsonl'))
    expect(files).toEqual([])
  })

  it('appendMessage：会话不存在 → null（不抛）', () => {
    const store = new SessionStore(dir)
    expect(store.appendMessage('nope', { role: 'user', content: 'x' })).toBeNull()
  })

  it('原子写：无残留 .tmp 文件', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    store.appendMessage(id, { role: 'user', content: 'x' })
    const files = readdirSync(sessionsDir())
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('损坏降级：单会话 JSONL 坏 → 标 corrupted + 返回 null，不吞其它会话', () => {
    const store = new SessionStore(dir)
    const good = store.create('好的')
    const bad = store.create('坏的')
    writeFileSync(join(sessionsDir(), `${bad.id}.jsonl`), '{ broken json', 'utf8')
    const store2 = new SessionStore(dir)
    expect(store2.get(bad.id)).toBeNull()
    expect(store2.list().find((m) => m.id === bad.id)!.corrupted).toBe(true)
    expect(store2.get(good.id)).not.toBeNull()
  })

  it('双写一致：append 后索引 updatedAt 与 meta 一致', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    const m = store.appendMessage(id, { role: 'user', content: 'x' })!
    const file = store.get(id)!
    const indexMeta = store.list().find((x) => x.id === id)!
    expect(file.meta.updatedAt).toBe(m.createdAt)
    expect(indexMeta.updatedAt).toBe(file.meta.updatedAt)
  })
})

describe('P1 存储正确性', () => {
  it('P1-3：index.json 损坏 → 重启后从目录**恢复**全部会话（不再退化为空）', () => {
    const store = new SessionStore(dir)
    const a = store.create('a')
    const b = store.create('b')
    writeFileSync(join(sessionsDir(), 'index.json'), 'not json', 'utf8')
    const store2 = new SessionStore(dir)
    const ids = store2.list().map((m) => m.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
    expect(store2.get(a.id)!.messages).toEqual([])
  })

  it('P1-3：索引里塞一条不存在的 id → 对账后 list() 不含它', () => {
    const store = new SessionStore(dir)
    const a = store.create('a')
    // 手动往索引里塞一条不存在的会话
    const idx = JSON.parse(readFileSync(join(sessionsDir(), 'index.json'), 'utf8')) as unknown[]
    idx.push({ id: 's_ghost', title: '幽灵', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })
    writeFileSync(join(sessionsDir(), 'index.json'), JSON.stringify(idx), 'utf8')
    const store2 = new SessionStore(dir)
    expect(store2.list().map((m) => m.id)).toEqual([a.id])
  })

  it('P1-2：删文件与写索引之间崩溃（文件没了、索引还在）→ 重启后不复活', () => {
    const store = new SessionStore(dir)
    const a = store.create('a')
    // 模拟「先 unlink 成功、writeIndex 之前崩了」：只删文件，索引原样保留
    rmSync(join(sessionsDir(), `${a.id}.jsonl`), { force: true })
    const store2 = new SessionStore(dir)
    expect(store2.list()).toEqual([])
  })

  it('P1-5：reasoning 有类型且落库后仍在', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    const m = store.appendMessage(id, { role: 'assistant', content: '答', reasoning: '先想…' })!
    expect(m.reasoning).toBe('先想…')
    expect(store.get(id)!.messages[0].reasoning).toBe('先想…')
  })

  it('cleanMessagePreview：去控制字符 / 压空白 / 截 120 码点', () => {
    expect(cleanMessagePreview('  a\t\tb\n c ')).toBe('a b c')
    expect(Array.from(cleanMessagePreview('x'.repeat(200))).length).toBe(120)
    // 按码点截，不劈开代理对（emoji）
    const emoji = '😀'.repeat(130)
    const out = cleanMessagePreview(emoji)
    expect(Array.from(out).length).toBe(120)
  })
})

describe('P1-6 · JSONL', () => {
  it('旧 .json 首次读取后迁移为 .jsonl，消息逐条相等', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    const legacy = {
      meta: { id: 's_old', title: '旧会话', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' },
      messages: [
        { id: 'm1', role: 'user', createdAt: '2020-01-01T00:00:00.000Z', content: 'hi' },
        { id: 'm2', role: 'assistant', createdAt: '2020-01-02T00:00:00.000Z', content: 'hello' },
      ],
    }
    writeFileSync(join(sessionsDir(), 's_old.json'), JSON.stringify(legacy), 'utf8')
    const store = new SessionStore(dir)
    const got = store.get('s_old')!
    expect(got.messages.map((m) => m.content)).toEqual(['hi', 'hello'])
    expect(existsSync(join(sessionsDir(), 's_old.jsonl'))).toBe(true)
    expect(existsSync(join(sessionsDir(), 's_old.json'))).toBe(false)
  })

  it('append 成本与已有多条数无关（O(1)，不再全量重写）', { timeout: 30_000 }, () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    const big = 'x'.repeat(3000)
    const time = (fn: () => void): number => {
      const s = performance.now()
      fn()
      return performance.now() - s
    }
    // 早期：文件 ~3KB
    store.appendMessage(id, { role: 'user', content: big })
    const early = time(() => {
      for (let i = 0; i < 20; i++) store.appendMessage(id, { role: 'assistant', content: big })
    }) / 20
    // 撑到 ~600 条（~1.8MB）
    for (let i = 0; i < 560; i++) store.appendMessage(id, { role: 'assistant', content: big })
    const late = time(() => {
      for (let i = 0; i < 20; i++) store.appendMessage(id, { role: 'assistant', content: big })
    }) / 20
    // 全量重写会随消息数线性涨（数百倍）；append-only 应基本持平
    expect(late).toBeLessThan(early * 6 + 3)
  })

  it('写到一半的末行（崩溃）被丢弃，前面完整消息保留', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    store.appendMessage(id, { role: 'user', content: 'complete' })
    const file = join(sessionsDir(), `${id}.jsonl`)
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"id":"m_half","role":"assist`, 'utf8')
    const store2 = new SessionStore(dir)
    expect(store2.get(id)!.messages.map((m) => m.content)).toEqual(['complete'])
  })
})

describe('P2 字段（pin / archive / lastMessage）', () => {
  it('setPinned：置顶生效且**不改 updatedAt**（否则会话会跳进「今天」）', () => {
    const store = new SessionStore(dir)
    const { id } = store.create('a')
    const before = store.list().find((m) => m.id === id)!.updatedAt
    const meta = store.setPinned(id, true)!
    expect(meta.pinned).toBe(true)
    expect(meta.updatedAt).toBe(before)
    // 取消
    expect(store.setPinned(id, false)!.pinned).toBeUndefined()
    expect(store.setPinned('nope', true)).toBeNull()
  })

  it('setArchived：归档生效且不改 updatedAt', () => {
    const store = new SessionStore(dir)
    const { id } = store.create('a')
    const before = store.list().find((m) => m.id === id)!.updatedAt
    const meta = store.setArchived(id, true)!
    expect(meta.archived).toBe(true)
    expect(meta.updatedAt).toBe(before)
    expect(store.setArchived(id, false)!.archived).toBeUndefined()
  })

  it('lastMessage：append user/assistant 时更新预览；tool 不更新', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    store.appendMessage(id, { role: 'assistant', content: '最后一条回答' })
    expect(store.list().find((m) => m.id === id)!.lastMessage).toBe('最后一条回答')
    store.appendMessage(id, { role: 'tool', content: '{"huge":"json"}' })
    expect(store.list().find((m) => m.id === id)!.lastMessage).toBe('最后一条回答')
  })

  it('create(parentId)：子会话带 parentId 落库并持久化', () => {
    const store = new SessionStore(dir)
    const parent = store.create('父')
    const child = store.create('子', parent.id)
    expect(child.parentId).toBe(parent.id)
    // 重新加载后仍在（JSONL + 索引）
    const store2 = new SessionStore(dir)
    expect(store2.list().find((m) => m.id === child.id)!.parentId).toBe(parent.id)
    // 顶层会话没有 parentId
    expect(store2.list().find((m) => m.id === parent.id)!.parentId).toBeUndefined()
  })
})
