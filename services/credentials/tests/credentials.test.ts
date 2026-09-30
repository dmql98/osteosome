/**
 * credentials 能力位单测（P2 WS-3 骨架 + P4 WS-2 core store）—— 纯逻辑 resolveCredential。
 *
 * 覆盖：env 命中 / 缺失 / 非法 ref；core:<id> 经注入 fetchCore 取值（命中 / 空值 / Core 报错 / 无 fetchCore）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { parseCredentialRef, resolveCredential } from '../src/resolve'

const SAVED_KEY = process.env.DEEPSEEK_API_KEY

afterEach(() => {
  if (SAVED_KEY === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = SAVED_KEY
})

describe('parseCredentialRef', () => {
  it('env: / core: 结构化解析', () => {
    expect(parseCredentialRef('env:DEEPSEEK_API_KEY')).toEqual({ kind: 'env', varName: 'DEEPSEEK_API_KEY' })
    expect(parseCredentialRef('core:my-cred')).toEqual({ kind: 'core', credentialId: 'my-cred' })
  })
  it('非法 ref 抛错', () => {
    expect(() => parseCredentialRef('bogus')).toThrow(/invalid ref/)
    expect(() => parseCredentialRef(':')).toThrow(/invalid ref/)
    expect(() => parseCredentialRef('file:foo')).toThrow(/unknown ref kind/)
  })
})

describe('resolveCredential · env kind', () => {
  it('env: 命中 → { ok, apiKey }', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-abc'
    await expect(resolveCredential('env:DEEPSEEK_API_KEY')).resolves.toEqual({ ok: true, apiKey: 'sk-abc' })
  })

  it('env: 缺失 → { ok:false, error.missing_credential }', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const r = await resolveCredential('env:DEEPSEEK_API_KEY')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'missing_credential', message: expect.stringContaining('not set') })
    }
  })

  it('非法 ref → { ok:false, error.missing_credential }（不抛）', async () => {
    const r = await resolveCredential('bogus')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'missing_credential', message: expect.stringContaining('invalid ref') })
    }
  })
})

describe('resolveCredential · core kind（P4 WS-2）', () => {
  it('core:<id> 命中 fetchCore → { ok, apiKey }', async () => {
    const fetchCore = vi.fn(async (id: string) => (id === 'my-cred' ? 'sk-from-core-store' : ''))
    const r = await resolveCredential('core:my-cred', { fetchCore })
    expect(r).toEqual({ ok: true, apiKey: 'sk-from-core-store' })
    expect(fetchCore).toHaveBeenCalledWith('my-cred')
  })

  it('core:<id> 返回空值 → missing_credential', async () => {
    const r = await resolveCredential('core:empty-cred', { fetchCore: async () => '  ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ code: 'missing_credential' })
  })

  it('core:<id> Core 报错（not_found）→ missing_credential（不裸奔）', async () => {
    const r = await resolveCredential('core:missing', {
      fetchCore: async () => {
        throw new Error('credentials.get: no credential')
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'missing_credential' })
      expect(r.error.message).toContain('missing')
    }
  })

  it('无 fetchCore 注入 → missing_credential（能力不可用）', async () => {
    const r = await resolveCredential('core:my-cred')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ code: 'missing_credential' })
  })
})
