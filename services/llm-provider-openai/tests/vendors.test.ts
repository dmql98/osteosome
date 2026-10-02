/**
 * 厂商预设表与实例构建单测（S1）。
 *
 * 覆盖三件最容易悄悄坏掉的事：
 * 1. 预设表本身的契约（id 唯一 / baseUrl 合法 / 凭证 env 名规范）；
 * 2. **未配置凭证即不注册** —— 这是「存在性由配置决定」的落点；
 * 3. env 覆盖优先（集成冒烟靠它把任意厂商指到假上游，不用改代码）。
 */
import { describe, expect, it } from 'vitest'
import {
  hasVendorCredential,
  resolveVendorBaseUrl,
  resolveVendorModel,
  VENDOR_PRESETS,
  vendorBaseUrlEnvName,
  vendorCredentialRef,
  vendorModelEnvName,
  providerServiceIdForWire,
  type VendorPreset,
} from '@osteosome/shared'
import {
  buildVendorInstances,
  parseVendorOverrides,
  SERVED_WIRE,
  toRegisteredPayload,
  type VendorInstance,
} from '../src/instances'

describe('厂商预设表（契约）', () => {
  it('id 唯一且都是合法 slug', () => {
    const ids = VENDOR_PRESETS.map((v) => v.id)
    expect(new Set(ids).size, `id 重复：${ids.join(',')}`).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('baseUrl 都是 https（本地端点除外）或 http://127.0.0.1', () => {
    for (const v of VENDOR_PRESETS) {
      const local = /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/.test(v.baseUrl)
      const remote = /^https:\/\//.test(v.baseUrl)
      expect(remote || local, `${v.id} 的 baseUrl 不合规：${v.baseUrl}`).toBe(true)
      expect(v.baseUrl.endsWith('/'), `${v.id} 的 baseUrl 不该以 / 结尾`).toBe(false)
    }
  })

  it('凭证 env 名规范（大写 + 下划线），免凭证厂商留空', () => {
    for (const v of VENDOR_PRESETS) {
      if (v.credentialEnv === '') continue
      expect(v.credentialEnv, `${v.id} 的 credentialEnv 不规范`).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/)
      expect(vendorCredentialRef(v)).toBe(`env:${v.credentialEnv}`)
    }
  })

  it('每家都有非空静态兜底目录或明确的免凭证说明', () => {
    for (const v of VENDOR_PRESETS) {
      // 本地端点的目录由用户启了什么决定，允许为空；远程厂商应给出兜底
      if (v.baseUrl.startsWith('http://127.0.0.1')) continue
      expect(v.models.length, `${v.id} 缺静态兜底目录`).toBeGreaterThan(0)
    }
  })

  it('本地端点（ollama / vllm / lm-studio）免凭证', () => {
    const local = VENDOR_PRESETS.filter((v) => v.baseUrl.startsWith('http://127.0.0.1'))
    expect(local.length).toBeGreaterThanOrEqual(3)
    for (const v of local) expect(hasVendorCredential(v, {})).toBe(true)
  })
})

describe('env 覆盖', () => {
  const deepseek = VENDOR_PRESETS.find((v) => v.id === 'deepseek')!

  it('env 名由 id 推导（- → _，大写）', () => {
    expect(vendorBaseUrlEnvName('deepseek')).toBe('DEEPSEEK_BASE_URL')
    expect(vendorModelEnvName('deepseek')).toBe('DEEPSEEK_MODEL')
    expect(vendorBaseUrlEnvName('lm-studio')).toBe('LM_STUDIO_BASE_URL')
  })

  it('<ID>_BASE_URL 覆盖端点并去尾部斜杠；空白值回落预设', () => {
    expect(resolveVendorBaseUrl(deepseek, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1/' })).toBe(
      'http://127.0.0.1:9/v1',
    )
    expect(resolveVendorBaseUrl(deepseek, { DEEPSEEK_BASE_URL: '   ' })).toBe(deepseek.baseUrl)
    expect(resolveVendorBaseUrl(deepseek, {})).toBe(deepseek.baseUrl)
  })

  it('<ID>_MODEL 覆盖默认模型；空白回落预设', () => {
    expect(resolveVendorModel(deepseek, { DEEPSEEK_MODEL: 'deepseek-reasoner' })).toBe('deepseek-reasoner')
    expect(resolveVendorModel(deepseek, {})).toBe(deepseek.defaultModel)
  })
})

describe('buildVendorInstances', () => {
  it('未配置凭证的厂商不注册（存在性由配置决定）', () => {
    const instances = buildVendorInstances({})
    // 免凭证的本地端点恒在
    expect(instances.map((i) => i.id)).toEqual(['lm-studio', 'ollama', 'vllm'])
  })

  it('配了哪个 *_API_KEY 就注册哪一家，且带上各自的端点与默认模型', () => {
    const instances = buildVendorInstances({
      OPENAI_API_KEY: 'k1',
      DEEPSEEK_API_KEY: 'k2',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
    })
    const byId = new Map(instances.map((i) => [i.id, i]))
    expect([...byId.keys()].sort()).toEqual(['deepseek', 'lm-studio', 'ollama', 'openai', 'vllm'])
    expect(byId.get('openai')).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: 'env:OPENAI_API_KEY',
      defaultModel: 'gpt-4o-mini',
    })
    expect(byId.get('deepseek')).toMatchObject({
      baseUrl: 'http://127.0.0.1:9',
      credentialRef: 'env:DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-reasoner',
    })
  })

  it('空白 key 视为未配置', () => {
    const ids = buildVendorInstances({ OPENAI_API_KEY: '   ' }).map((i) => i.id)
    expect(ids).not.toContain('openai')
  })

  it('注册顺序按 id 排序（冒烟断言可预期）', () => {
    const instances = buildVendorInstances({ ZAI_API_KEY: 'k', MOONSHOT_API_KEY: 'k', OPENAI_API_KEY: 'k' })
    const remote = instances.map((i) => i.id).filter((id) => !['ollama', 'vllm', 'lm-studio'].includes(id))
    expect([...remote].sort()).toEqual(remote)
  })

  it('LLM_VENDORS_EXTRA：自填端点按 env:<ID>_API_KEY 推断凭证，未配置则不注册', () => {
    const raw = JSON.stringify([{ id: 'my-proxy', baseUrl: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen' }])
    expect(parseVendorOverrides(raw)).toHaveLength(1)
    expect(buildVendorInstances({ LLM_VENDORS_EXTRA: raw }).map((i) => i.id)).not.toContain('my-proxy')
    const withKey = buildVendorInstances({ LLM_VENDORS_EXTRA: raw, MY_PROXY_API_KEY: 'k' })
    const mine = withKey.find((i) => i.id === 'my-proxy')!
    expect(mine).toMatchObject({
      label: 'my-proxy',
      baseUrl: 'http://127.0.0.1:8080/v1',
      credentialRef: 'env:MY_PROXY_API_KEY',
      defaultModel: 'qwen',
    })
  })

  it('自填项可显式给 credentialRef:"" 走免凭证；同 id 覆盖预设', () => {
    const raw = JSON.stringify([
      { id: 'ollama', baseUrl: 'http://192.168.1.10:11434/v1', credentialRef: '', label: '远程 Ollama' },
    ])
    const mine = buildVendorInstances({ LLM_VENDORS_EXTRA: raw }).find((i) => i.id === 'ollama')!
    expect(mine).toMatchObject({ baseUrl: 'http://192.168.1.10:11434/v1', label: '远程 Ollama', credentialRef: '' })
  })

  it('畸形 LLM_VENDORS_EXTRA 静默忽略（不因一条坏配置起不来）', () => {
    expect(parseVendorOverrides('not-json')).toEqual([])
    expect(parseVendorOverrides('{"a":1}')).toEqual([])
    expect(parseVendorOverrides('[{"label":"缺 id"}]')).toEqual([])
    expect(buildVendorInstances({ LLM_VENDORS_EXTRA: 'not-json' }).map((i) => i.id)).toEqual([
      'lm-studio',
      'ollama',
      'vllm',
    ])
  })
})

describe('toRegisteredPayload', () => {
  it('映射成 llm.provider.registered 的形状（provider / defaultModel / credentialRef / retryPolicy）', () => {
    const inst: VendorInstance = {
      id: 'x',
      label: 'X',
      baseUrl: 'http://x/v1',
      credentialRef: 'env:X_API_KEY',
      defaultModel: 'm',
      staticModels: [],
    }
    const payload = toRegisteredPayload(inst)
    expect(Object.keys(payload).sort()).toEqual(['credentialRef', 'defaultModel', 'provider', 'retryPolicy'])
    expect(payload.provider).toBe('x')
    expect(payload.retryPolicy.retryableCodes).toContain('rate_limited')
  })
})

describe('预设表可扩展性（加一家 = 加一行）', () => {
  it('传入自定义预设表即可新增厂商，无需改本模块任何代码', () => {
    const custom: VendorPreset = {
      id: 'acme',
      label: 'ACME',
      baseUrl: 'https://api.acme.test/v1',
      api: 'openai',
      credentialEnv: 'ACME_API_KEY',
      defaultModel: 'acme-1',
      models: ['acme-1'],
    }
    const instances = buildVendorInstances({ ACME_API_KEY: 'k' }, [...VENDOR_PRESETS, custom])
    expect(instances.find((i) => i.id === 'acme')).toMatchObject({
      baseUrl: 'https://api.acme.test/v1',
      credentialRef: 'env:ACME_API_KEY',
      defaultModel: 'acme-1',
    })
  })
})

describe('本进程只服务自己的 wire（不注册兑现不了的 provider）', () => {
  it('预设表里 api 不是 openai 的行，本进程不碰（那是别的 provider 进程的事）', () => {
    const alien: VendorPreset = {
      id: 'opencode',
      label: 'OpenCode',
      baseUrl: 'https://api.opencode.test',
      api: 'opencode',
      credentialEnv: 'OPENCODE_API_KEY',
      defaultModel: 'oc-1',
      models: ['oc-1'],
    }
    const instances = buildVendorInstances({ OPENCODE_API_KEY: 'k' }, [...VENDOR_PRESETS, alien])
    // 关键：不能出现 'opencode'。注册它等于对外声称会发 opencode 请求体，实际发的是 openai 的
    expect(instances.map((i) => i.id)).not.toContain('opencode')
    // 而默认的 12 家照常在（env 覆盖让免凭证端点可见）
    expect(instances.length).toBeGreaterThan(0)
  })

  it('默认参数只喂本 wire 的预设，缺省调用不会越界', () => {
    // 不传 presets 时用的是 presetsForWire(SERVED_WIRE) 而不是整张表
    const instances = buildVendorInstances({})
    expect(instances.every((i) => i.preset === undefined || i.preset.api === SERVED_WIRE)).toBe(true)
  })

  it('自填端点声明了别家 wire → 拒绝注册并收集原因（不静默丢弃）', () => {
    const rejected: Array<{ id: string; api: string }> = []
    const instances = buildVendorInstances(
      {
        OPENCODE_API_KEY: 'k',
        MINE_OK_API_KEY: 'k',
        LLM_VENDORS_EXTRA: JSON.stringify([
          { id: 'mine-oc', baseUrl: 'https://x.test/v1', api: 'opencode' },
          { id: 'mine-ok', baseUrl: 'https://y.test/v1' },
        ]),
      },
      undefined,
      rejected,
    )
    expect(rejected).toEqual([{ id: 'mine-oc', api: 'opencode' }])
    expect(instances.map((i) => i.id)).not.toContain('mine-oc')
    // 缺省 api 的自填项照常注册（绝大多数自建端点就是 openai 兼容）
    expect(instances.find((i) => i.id === 'mine-ok')).toBeDefined()
  })

  it('SERVED_WIRE 与服务 id 对得上（约定 llm-provider-<wire>）', () => {
    expect(providerServiceIdForWire(SERVED_WIRE)).toBe('llm-provider-openai')
  })
})
