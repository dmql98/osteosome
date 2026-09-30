/**
 * credentials 能力位单测（P2 WS-3）—— 纯逻辑 resolveCredential（env 命中 / 缺失 / core 预留 / 非法 ref）。
 */
import { describe, expect, it, afterEach } from 'vitest'
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

describe('resolveCredential', () => {
  it('env: 命中 → { ok, apiKey }', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-abc'
    expect(resolveCredential('env:DEEPSEEK_API_KEY')).toEqual({ ok: true, apiKey: 'sk-abc' })
  })

  it('env: 缺失 → { ok:false, error.missing_credential }', () => {
    delete process.env.DEEPSEEK_API_KEY
    const r = resolveCredential('env:DEEPSEEK_API_KEY')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'missing_credential', message: expect.stringContaining('not set') })
    }
  })

  it('core: kind → 明确 unimplemented（P4 预留）', () => {
    const r = resolveCredential('core:my-cred')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'missing_credential', message: expect.stringContaining('not implemented yet (P4)') })
    }
  })

  it('非法 ref → { ok:false, error.missing_credential }（不抛）', () => {
    const r = resolveCredential('bogus')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'missing_credential', message: expect.stringContaining('invalid ref') })
    }
  })
})
