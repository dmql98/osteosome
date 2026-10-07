/**
 * session store 原子写与并发韧性（P4b P1-1 / P1-4）。
 *
 * 用 `vi.mock('node:fs')` 把 `renameSync` 换成可注入的替身 —— 这是唯一能**真的**在
 * rename 前制造失败的手段（故障注入，不是「看起来对」）。
 */
import { describe, expect, it, beforeEach, afterEach, vi, type Mock } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/store'

let dir: string
const sessionDir = () => join(dir, 'sessions')
const renameMock = () => fs.renameSync as unknown as Mock

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-atomic-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('原子写韧性', () => {
  it('P1-1：rename 失败时不毁旧文件（旧实现先 rmSync 会留下空目录）', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    renameMock().mockImplementation(actual.renameSync)

    const store = new SessionStore(dir)
    const { id } = store.create('a')
    const before = readFileSync(join(sessionDir(), 'index.json'), 'utf8')

    // 下一次 rename（= setPinned 的 atomicWrite(index)）抛错
    renameMock().mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => store.setPinned(id, true)).toThrow('boom')

    // 旧 index.json 原封不动（没有「目标被删掉」的窗口）
    expect(readFileSync(join(sessionDir(), 'index.json'), 'utf8')).toBe(before)
    // 临时文件被清理，不留半截
    expect(readdirSync(sessionDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('P1-4：每次原子写的临时文件名互不相同', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const seen: string[] = []
    renameMock().mockImplementation((src: string, dst: string) => {
      seen.push(String(src))
      return actual.renameSync(src, dst)
    })

    const store = new SessionStore(dir)
    const { id } = store.create('a')
    for (let i = 0; i < 20; i += 1) store.appendMessage(id, { role: 'user', content: `m${i}` })

    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('两个 store 实例写同一会话：文件里两条都在，无 .tmp 残留', () => {
    const s1 = new SessionStore(dir)
    const { id } = s1.create('shared')
    const s2 = new SessionStore(dir)
    s1.appendMessage(id, { role: 'user', content: 'A' })
    s2.appendMessage(id, { role: 'user', content: 'B' })
    const s3 = new SessionStore(dir)
    expect(s3.get(id)!.messages.map((m) => m.content)).toEqual(['A', 'B'])
    expect(readdirSync(sessionDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
