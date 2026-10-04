/**
 * 凭证 store 单测（P4 WS-1）—— 原子写 / 损坏降级 / 掩码 / 值不进事件。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../src/bus/bus'
import { CredentialStore, CredentialStoreError, maskValue } from '../src/credentials/store'
import { CredentialApi } from '../src/credentials/api'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-cred-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('maskValue', () => {
  it('长值保留头 4 尾 4；短值整体打码', () => {
    expect(maskValue('sk-abcdefghijklmnop')).toBe('sk-a…mnop')
    expect(maskValue('short')).toBe('•••••')
  })
})

describe('CredentialStore', () => {
  it('set → 掩码列表（不返回原值）', () => {
    const store = new CredentialStore(dir)
    const masked = store.set({ name: 'DeepSeek key', provider: 'deepseek', value: 'sk-secret-value-1234' })
    expect(masked.masked).not.toBe('sk-secret-value-1234')
    expect(masked.name).toBe('DeepSeek key')
    // 列表里只有掩码形态
    const list = store.maskedList()
    expect(list[0].masked).toBe(maskValue('sk-secret-value-1234'))
    expect(JSON.stringify(list)).not.toContain('sk-secret-value-1234')
  })

  it('get → 原值（仅服务进程通道）', () => {
    const store = new CredentialStore(dir)
    const masked = store.set({ name: 'k', provider: 'p', value: 'raw-value-xyz' })
    expect(store.get(masked.id).value).toBe('raw-value-xyz')
  })

  it('原子写：无残留 .tmp', () => {
    const store = new CredentialStore(dir)
    store.set({ name: 'a', provider: 'p', value: 'v1' })
    const files = readdirSync(join(dir, 'core'))
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(files).toContain('credentials.json')
  })

  it('覆盖写：同 id 更新 value + updatedAt', () => {
    const store = new CredentialStore(dir)
    const first = store.set({ name: 'k', provider: 'p', value: 'old' })
    const second = store.set({ id: first.id, name: 'k', provider: 'p', value: 'new' })
    expect(second.id).toBe(first.id)
    expect(store.get(first.id).value).toBe('new')
    expect(store.maskedList()).toHaveLength(1)
  })

  it('delete → 移除；不存在返回 false', () => {
    const store = new CredentialStore(dir)
    const masked = store.set({ name: 'k', provider: 'p', value: 'v' })
    expect(store.delete(masked.id)).toBe(true)
    expect(store.delete(masked.id)).toBe(false)
  })

  it('损坏文件 → corrupted 标记，get/set 报错但服务可构造（不崩）', () => {
    mkdirSync(join(dir, 'core'), { recursive: true })
    writeFileSync(join(dir, 'core', 'credentials.json'), 'not valid json', 'utf8')
    const store = new CredentialStore(dir)
    expect(store.isCorrupted()).toBe(true)
    expect(() => store.get('x')).toThrow(CredentialStoreError)
    expect(() => store.set({ name: 'k', provider: 'p', value: 'v' })).toThrow(CredentialStoreError)
  })

  it('脏条目跳过（缺 value 的条目不加载）', () => {
    mkdirSync(join(dir, 'core'), { recursive: true })
    writeFileSync(
      join(dir, 'core', 'credentials.json'),
      JSON.stringify({ a: { id: 'a', name: 'A', provider: 'p', value: 'ok' }, b: { id: 'b' } }),
      'utf8',
    )
    const store = new CredentialStore(dir)
    expect(store.maskedList()).toHaveLength(1)
    expect(store.maskedList()[0].id).toBe('a')
  })

  it('rehydrate：重新构造 store 从磁盘读到凭证', () => {
    const store = new CredentialStore(dir)
    const masked = store.set({ name: 'k', provider: 'p', value: 'persisted' })
    const store2 = new CredentialStore(dir)
    expect(store2.get(masked.id).value).toBe('persisted')
  })
})

describe('CredentialApi · 值不进事件（P4 红线）', () => {
  it('set → credential.saved 事件只带 { id, name, provider }，无 value', async () => {
    const bus = new Bus()
    const api = new CredentialApi(new CredentialStore(dir), bus)
    const events: Record<string, unknown>[] = []
    bus.subscribe('credential.saved', (payload) => {
      events.push(payload as unknown as Record<string, unknown>)
    })

    const masked = api.set({ name: 'Secret key', provider: 'deepseek', value: 'sk-super-secret' })
    await new Promise((r) => setTimeout(r, 10)) // 等微任务投递

    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev).toMatchObject({ id: masked.id, name: 'Secret key', provider: 'deepseek' })
    // 值绝不入事件
    expect(JSON.stringify(ev)).not.toContain('sk-super-secret')
    expect('value' in ev).toBe(false)
  })

  it('delete → credential.deleted 事件只带 id', async () => {
    const bus = new Bus()
    const api = new CredentialApi(new CredentialStore(dir), bus)
    const masked = api.set({ name: 'k', provider: 'p', value: 'sk-xyz' })

    const events: Record<string, unknown>[] = []
    bus.subscribe('credential.deleted', (payload) => {
      events.push(payload as unknown as Record<string, unknown>)
    })
    api.delete(masked.id)
    await new Promise((r) => setTimeout(r, 10))

    expect(events[0]).toMatchObject({ id: masked.id })
    expect(JSON.stringify(events)).not.toContain('sk-xyz')
  })

  it('getRaw → 原值（唯一出 Core 的通道）', () => {
    const bus = new Bus()
    const api = new CredentialApi(new CredentialStore(dir), bus)
    const masked = api.set({ name: 'k', provider: 'p', value: 'raw-only-here' })
    expect(api.getRaw(masked.id)).toEqual({ value: 'raw-only-here' })
  })
})
