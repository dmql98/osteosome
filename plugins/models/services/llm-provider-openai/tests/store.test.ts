/**
 * `ModelsStore` 的行为单测 —— 密钥与接入清单的**唯一写者**。
 *
 * 这里守的每一条都对应一句设计承诺：
 * - **明文只在本进程**：掩码列表里没有 value，`credentialValue` 是唯一的原值出口；
 * - **合并式写**：`patchPrefs` 只改给的键（两个窗口同时改不会互相吃掉）；
 * - **脏数据不带走整份**：一个坏条目被跳过，一个坏文件被标记而不是让服务起不来；
 * - **dataDir 空目录直接抛**：宁可不起来，也不要静默写到 `dist/`（F-01 那个坑）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelsStore, ModelsStoreError, maskValue, parsePrefs } from '../src/store'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ost-models-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ModelsStore · 落盘位置与形状', () => {
  it('两个文件都在传进来的 dataDir 下（不是 CWD，也不是 dist）', () => {
    const store = new ModelsStore(dir)
    store.patchPrefs({ connectedVendors: ['lm-studio'] })
    store.putCredential({ name: 'k', provider: 'deepseek', value: 'sk-1' })

    expect(existsSync(path.join(dir, 'preferences.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'credentials.json'))).toBe(true)
    // 形状：接入清单是**扁平**的（文件本身已经表明归谁，不再套一层 llm）
    expect(JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf8'))).toEqual({
      connectedVendors: ['lm-studio'],
      vendorOverrides: [],
      enabledModels: [],
      modelProfiles: {},
    })
  })

  it('dataDir 为空 → 抛（不静默写到别处）', () => {
    // 这是 F-01 的教训：`service.dataDir` 在 start 之前恒为 ''，那时建仓库就落错地方了
    expect(() => new ModelsStore('')).toThrow(ModelsStoreError)
  })
})

describe('ModelsStore · 密钥', () => {
  it('掩码列表**没有 value 字段**；原值只能从 credentialValue 拿', () => {
    const store = new ModelsStore(dir)
    const masked = store.putCredential({ id: 'c1', name: 'deepseek', provider: 'deepseek', value: 'sk-secret-1234' })

    expect(masked).not.toHaveProperty('value')
    expect(masked.masked).toBe('sk-s…1234')
    const list = store.maskedCredentials()
    expect(list[0]).not.toHaveProperty('value')
    // 明文出口只有一个，且是本进程的方法调用
    expect(store.credentialValue('c1')).toBe('sk-secret-1234')
  })

  it('不存在的 id 抛 not_found（不返回空串 —— 空 apiKey 会换来一个指向错误方向的 401）', () => {
    const store = new ModelsStore(dir)
    expect(() => store.credentialValue('nope')).toThrow(ModelsStoreError)
  })

  it('credentialIdByProvider 把厂商与密钥对上（注册时靠它）', () => {
    const store = new ModelsStore(dir)
    store.putCredential({ id: 'c1', name: 'a', provider: 'deepseek', value: 'x1' })
    store.putCredential({ id: 'c2', name: 'b', provider: 'openai', value: 'x2' })
    expect(store.credentialIdByProvider().get('deepseek')).toBe('c1')
    expect(store.credentialIdByProvider().get('openai')).toBe('c2')
  })

  it('删除后凭据与索引都没了；删不存在的返回 false', () => {
    const store = new ModelsStore(dir)
    store.putCredential({ id: 'c1', name: 'a', provider: 'p', value: 'x1' })
    expect(store.deleteCredential('c1')).toBe(true)
    expect(store.deleteCredential('c1')).toBe(false)
    expect(store.maskedCredentials()).toEqual([])
    expect(store.credentialIdByProvider().size).toBe(0)
  })

  it('重开一次（模拟进程重启）读回同一份 —— 密钥不是只在内存里', () => {
    new ModelsStore(dir).putCredential({ id: 'c1', name: 'a', provider: 'deepseek', value: 'sk-persist' })
    const again = new ModelsStore(dir)
    expect(again.credentialValue('c1')).toBe('sk-persist')
    expect(again.credentialIdByProvider().get('deepseek')).toBe('c1')
  })

  it('凭据文件坏掉 → 标记 + 当空处理（服务照常起，用户丢的只是那一条）', () => {
    writeFileSync(path.join(dir, 'credentials.json'), '{ 坏掉的 json', 'utf8')
    const store = new ModelsStore(dir)
    expect(store.credsCorrupted).toBe(true)
    expect(store.maskedCredentials()).toEqual([])
    // 下一次写会把文件重建出来（不留一个永远坏的）
    store.putCredential({ id: 'c1', name: 'a', provider: 'p', value: 'x' })
    expect(new ModelsStore(dir).credentialValue('c1')).toBe('x')
  })

  it('文件里一个脏条目被跳过，其余照用（不让一行坏数据带走整份）', () => {
    writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        good: { id: 'good', name: 'g', provider: 'p', kind: 'apiKey', value: 'v1' },
        bad: { name: '没有 id 也没有 value' },
      }),
      'utf8',
    )
    const store = new ModelsStore(dir)
    expect(store.maskedCredentials().map((c) => c.id)).toEqual(['good'])
  })
})

describe('ModelsStore · 接入清单', () => {
  it('合并式写：没给的键保持原样', () => {
    const store = new ModelsStore(dir)
    store.patchPrefs({ connectedVendors: ['lm-studio'], enabledModels: ['a::m'] })
    store.patchPrefs({ connectedVendors: ['ollama'] })

    const prefs = store.getPrefs()
    expect(prefs.connectedVendors).toEqual(['ollama'])
    expect(prefs.enabledModels).toEqual(['a::m']) // 这一键没给，所以没被清掉
  })

  it('重开一次读回同一份', () => {
    new ModelsStore(dir).patchPrefs({
      vendorOverrides: [{ id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' }],
    })
    expect(new ModelsStore(dir).getPrefs().vendorOverrides).toEqual([
      { id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' },
    ])
  })

  it('脏类型被丢掉（不是把整份变成空 —— 那样用户会以为配置被清了）', () => {
    const store = new ModelsStore(dir)
    store.patchPrefs({ connectedVendors: ['lm-studio'] } as never)
    store.patchPrefs({ connectedVendors: '不是数组' } as never)
    // 不该崩，且这次改动被忽略
    expect(store.getPrefs().connectedVendors).toEqual(['lm-studio'])
  })

  it('偏好文件坏掉 → 标记 + 当空处理', () => {
    writeFileSync(path.join(dir, 'preferences.json'), 'nope', 'utf8')
    const store = new ModelsStore(dir)
    expect(store.prefsCorrupted).toBe(true)
    expect(store.getPrefs()).toEqual({ connectedVendors: [], vendorOverrides: [], enabledModels: [], modelProfiles: {} })
  })
})

describe('parsePrefs · 容错解析', () => {
  it('非对象 → 缺省值', () => {
    for (const bad of [null, 42, 'x', [1, 2]]) {
      expect(parsePrefs(bad)).toEqual({ connectedVendors: [], vendorOverrides: [], enabledModels: [], modelProfiles: {} })
    }
  })

  it('只认数组型的键', () => {
    expect(parsePrefs({ connectedVendors: ['a', 7], enabledModels: 'x' })).toEqual({
      connectedVendors: ['a'],
      vendorOverrides: [],
      enabledModels: [],
      modelProfiles: {},
    })
  })

  /**
   * 能力表是**用户手填**的（上下文窗口可能被输成 `abc`），所以逐字段收窄：
   * 坏字段丢掉、其余保留。整表作废会让一个模型的能力连同合法的三项一起消失。
   */
  it('能力表：坏字段丢掉，好字段留下，空条目不留', () => {
    expect(
      parsePrefs({
        modelProfiles: {
          'ollama::qwen2.5-7b': {
            contextWindow: 32768,
            maxTokens: 'a lot',
            input: ['text', 'image', 'video'],
            reasoningEfforts: ['off', 'low', 'low'],
          },
          'ollama::broken': {},
          'ollama::junk': 'nope',
        },
      }).modelProfiles,
    ).toEqual({
      'ollama::qwen2.5-7b': {
        contextWindow: 32768,
        input: ['text', 'image'],
        reasoningEfforts: ['off', 'low'],
      },
    })
  })

  it('能力表：非对象/非数组一律当空（不抛，服务照常起）', () => {
    expect(parsePrefs({ modelProfiles: [1, 2] }).modelProfiles).toEqual({})
    expect(parsePrefs({ modelProfiles: 'x' }).modelProfiles).toEqual({})
    expect(parsePrefs({ modelProfiles: null }).modelProfiles).toEqual({})
  })
})

describe('ModelsStore · 模型能力（patchPrefs）', () => {
  it('整表替换（不是按键合并）—— 「删掉某条能力」才能真的删掉', () => {
    const store = new ModelsStore(dir)
    store.patchPrefs({
      modelProfiles: {
        'ollama::a': { contextWindow: 8000 },
        'ollama::b': { maxTokens: 512 },
      },
    })
    // 合并语义下「删 b」与「没提 b」长得一样，所以这里必须是整表替换
    store.patchPrefs({ modelProfiles: { 'ollama::a': { contextWindow: 32768 } } })
    expect(store.getPrefs().modelProfiles).toEqual({ 'ollama::a': { contextWindow: 32768 } })
  })

  it('没给 modelProfiles 的那次写不改它', () => {
    const store = new ModelsStore(dir)
    store.patchPrefs({ modelProfiles: { 'ollama::a': { contextWindow: 8000 } } })
    store.patchPrefs({ connectedVendors: ['ollama'] })
    expect(store.getPrefs().modelProfiles).toEqual({ 'ollama::a': { contextWindow: 8000 } })
  })

  it('落盘再读回：能力表不是只在内存里', () => {
    new ModelsStore(dir).patchPrefs({ modelProfiles: { 'ollama::a': { input: ['text', 'image'] } } })
    expect(new ModelsStore(dir).getPrefs().modelProfiles).toEqual({ 'ollama::a': { input: ['text', 'image'] } })
  })
})

describe('maskValue', () => {
  it('短值整体打码；长值留头 4 尾 4', () => {
    expect(maskValue('abcd')).toBe('••••')
    expect(maskValue('sk-1234567890')).toBe('sk-1…7890')
  })
})