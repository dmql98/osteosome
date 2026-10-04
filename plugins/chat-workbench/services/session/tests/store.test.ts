/**
 * session store 单测（P3 WS-1）—— CRUD / append-only / 原子写 / 损坏降级 / 双写一致。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-session-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('create：生成 id/默认标题，索引 + 全文双写一致', () => {
    const store = new SessionStore(dir)
    const meta = store.create()
    expect(meta.id).toMatch(/^s_/)
    expect(meta.title).toBe('新会话')
    // 索引含该会话
    expect(store.list().map((m) => m.id)).toEqual([meta.id])
    // 全文文件已落
    const file = join(dir, 'sessions', `${meta.id}.json`)
    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meta: { id: string }; messages: unknown[] }
    expect(parsed.meta.id).toBe(meta.id)
    expect(parsed.messages).toEqual([])
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
    // 既有消息对象未被后续 append 改动
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

  it('rename：改标题 + updatedAt 刷新，索引同步', () => {
    const store = new SessionStore(dir)
    const { id } = store.create('旧名')
    const meta = store.rename(id, '新名')!
    expect(meta.title).toBe('新名')
    expect(store.list().find((m) => m.id === id)!.title).toBe('新名')
    // 不存在 → null
    expect(store.rename('nope', 'x')).toBeNull()
  })

  it('remove：删索引 + 删全文，返回 true；不存在 false', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    const file = join(dir, 'sessions', `${id}.json`)
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
    const files = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.json') && f !== 'index.json')
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
    const files = readdirSync(join(dir, 'sessions'))
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('损坏降级：单会话 JSON 坏 → 标 corrupted + 返回 null，不吞其它会话', () => {
    const store = new SessionStore(dir)
    const good = store.create('好的')
    const bad = store.create('坏的')
    // 破坏「坏的」全文
    writeFileSync(join(dir, 'sessions', `${bad.id}.json`), '{ broken json', 'utf8')
    // 重新加载（清缓存走磁盘路径）
    const store2 = new SessionStore(dir)
    expect(store2.get(bad.id)).toBeNull()
    expect(store2.list().find((m) => m.id === bad.id)!.corrupted).toBe(true)
    // 好的会话仍可读
    expect(store2.get(good.id)).not.toBeNull()
  })

  it('index.json 损坏 → 退化为空索引（不崩服务）', () => {
    const store = new SessionStore(dir)
    store.create('a')
    writeFileSync(join(dir, 'sessions', 'index.json'), 'not json', 'utf8')
    const store2 = new SessionStore(dir)
    expect(store2.list()).toEqual([])
    // 仍可新建（索引重建）
    expect(store2.create('b')).toBeTruthy()
  })

  it('双写一致：append 后索引 updatedAt 与全文一致', () => {
    const store = new SessionStore(dir)
    const { id } = store.create()
    const m = store.appendMessage(id, { role: 'user', content: 'x' })!
    const file = store.get(id)!
    const indexMeta = store.list().find((x) => x.id === id)!
    expect(file.meta.updatedAt).toBe(m.createdAt)
    expect(indexMeta.updatedAt).toBe(file.meta.updatedAt)
  })
})
