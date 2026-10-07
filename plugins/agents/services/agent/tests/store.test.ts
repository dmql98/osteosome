/**
 * agent 服务的角色存储单测（P5 WS-1）—— 合并式 upsert / 删除 / 持久化 / 原子写 / 坏档降级。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CharacterStore } from '../src/store'

let dir: string
const file = () => join(dir, 'characters.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-agent-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CharacterStore', () => {
  it('缺席 → 空数组（还没有角色，合法）', () => {
    const store = new CharacterStore(dir)
    expect(store.list()).toEqual([])
    expect(existsSync(file())).toBe(false)
  })

  it('apply upsert：新建 + 合并式改，落盘可重读', () => {
    const store = new CharacterStore(dir)
    expect(store.apply({ character: { id: 'a', name: '评审员', prompt: '你是评审员' } }).changed).toBe(true)
    expect(store.apply({ character: { id: 'a', skills: ['git-diff'] } }).changed).toBe(true)
    const a = store.get('a')!
    expect(a).toMatchObject({ id: 'a', name: '评审员', prompt: '你是评审员', skills: ['git-diff'], tools: '*' })

    const store2 = new CharacterStore(dir)
    expect(store2.get('a')).toMatchObject({ name: '评审员', skills: ['git-diff'] })
  })

  it('apply removed：按 id 删；不存在 → changed:false', () => {
    const store = new CharacterStore(dir)
    store.apply({ character: { id: 'a' } })
    expect(store.apply({ removed: 'a' }).changed).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.apply({ removed: 'nope' }).changed).toBe(false)
  })

  it('apply 空 patch → changed:false（不落盘、不重播）', () => {
    const store = new CharacterStore(dir)
    expect(store.apply({}).changed).toBe(false)
  })

  it('坏档：JSON 坏 → 空数组不崩，下一次写入重建', () => {
    writeFileSync(file(), '{ not json', 'utf8')
    const store = new CharacterStore(dir)
    expect(store.list()).toEqual([])
    expect(store.takeErrors().length).toBeGreaterThan(0)
    expect(store.apply({ character: { id: 'a' } }).changed).toBe(true)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual([expect.objectContaining({ id: 'a' })])
  })

  it('部分坏档：逐条保留合法的，报错的进 errors', () => {
    writeFileSync(file(), JSON.stringify([{ id: 'good', name: '好' }, { name: 'no id' }]), 'utf8')
    const store = new CharacterStore(dir)
    expect(store.list().map((c) => c.id)).toEqual(['good'])
    expect(store.takeErrors().length).toBeGreaterThan(0)
  })

  it('原子写：不留 .tmp', () => {
    const store = new CharacterStore(dir)
    store.apply({ character: { id: 'a', prompt: 'x' } })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
