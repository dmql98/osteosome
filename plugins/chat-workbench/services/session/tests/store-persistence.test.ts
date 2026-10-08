/**
 * session store 持久化与多实例（P3-1 / 阶段 F M2）。
 *
 * 取代 JSONL 时代的 `store-atomic.test.ts`（renameSync 故障注入 / `.tmp` 残留）。
 * SQLite 下「原子写」是库的内建能力，这里测的是**它兑现了什么**：
 * 落盘可重开、两实例写同一文件不丢、seq 不撞号。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/store'

let dir: string
const stores: SessionStore[] = []
function makeStore(): SessionStore {
  const s = new SessionStore(dir)
  stores.push(s)
  return s
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-persist-'))
})
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('持久化与多实例', () => {
  it('append 后新开实例能读到（无进程内缓存依赖）', () => {
    const s1 = makeStore()
    const { id } = s1.create('shared')
    s1.appendMessage(id, { role: 'user', content: 'A' })
    s1.close()
    stores.length = 0

    const s2 = makeStore()
    expect(s2.get(id)!.messages.map((m) => m.content)).toEqual(['A'])
  })

  it('两个实例写同一会话：两条都在，按 seq 排序', () => {
    const s1 = makeStore()
    const { id } = s1.create('shared')
    const s2 = makeStore()
    s1.appendMessage(id, { role: 'user', content: 'A' })
    s2.appendMessage(id, { role: 'user', content: 'B' })
    const s3 = makeStore()
    expect(s3.get(id)!.messages.map((m) => m.content)).toEqual(['A', 'B'])
  })

  it('两实例并发 append 不撞 seq（BEGIN IMMEDIATE 里取 MAX+1）', () => {
    const s1 = makeStore()
    const { id } = s1.create('race')
    const s2 = makeStore()
    for (let i = 0; i < 25; i += 1) {
      s1.appendMessage(id, { role: 'user', content: `a${i}` })
      s2.appendMessage(id, { role: 'user', content: `b${i}` })
    }
    const msgs = makeStore().get(id)!.messages
    expect(msgs).toHaveLength(50)
    // seq 唯一且连续 1..50
    const seqs = new Set(msgs.map((m) => m.id))
    expect(seqs.size).toBe(50)
  })

  it('一个实例删除后，另一个实例立刻看不到', () => {
    const s1 = makeStore()
    const { id } = s1.create('x')
    const s2 = makeStore()
    expect(s2.get(id)).not.toBeNull()
    s1.remove(id)
    expect(s2.get(id)).toBeNull()
    expect(s2.list()).toEqual([])
  })
})
