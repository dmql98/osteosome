/**
 * `migratePluginOwnedData` —— 插件用户数据归位。
 *
 * 守的是三件最容易出事的事：
 * 1. **密钥不许丢**：复制 → 校验能读回 → 才删源（两头都不出现「密钥消失」）；
 * 2. **不许覆盖**：目标已存在 = 已经迁过（或用户自己放了一份），一律不动；
 * 3. **不许留下第二处真相**：`llm` 段成功写进插件目录之后，Core 偏好里那个键必须消失。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratePluginOwnedData } from '../src/config/paths'

let root = ''

function writeCore(file: string, body: unknown): void {
  mkdirSync(path.join(root, 'core'), { recursive: true })
  writeFileSync(path.join(root, 'core', file), JSON.stringify(body, null, 2), 'utf8')
}

function readModels(file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, 'plugin', 'models', file), 'utf8'))
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ost-rehome-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('migratePluginOwnedData', () => {
  it('密钥从 core/ 搬到 plugin/models/，搬完源文件**消失**（明文不留副本）', () => {
    writeCore('credentials.json', { cred_1: { id: 'cred_1', provider: 'deepseek', value: 'sk-x' } })

    const done = migratePluginOwnedData(root)

    expect(existsSync(path.join(root, 'core', 'credentials.json'))).toBe(false)
    expect(readModels('credentials.json')).toEqual({
      cred_1: { id: 'cred_1', provider: 'deepseek', value: 'sk-x' },
    })
    expect(done.join()).toContain('core/credentials.json -> plugin/models/credentials.json')
  })

  it('Core 偏好里的 llm 段搬到 plugin/models/preferences.json，且**摘掉 llm 这层壳**', () => {
    writeCore('preferences.json', {
      'ui.theme': 'light',
      llm: {
        connectedVendors: ['lm-studio'],
        vendorOverrides: [{ id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' }],
        enabledModels: ['lm-studio::qwen3-14b'],
      },
    })

    migratePluginOwnedData(root)

    expect(readModels('preferences.json')).toEqual({
      connectedVendors: ['lm-studio'],
      vendorOverrides: [{ id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' }],
      enabledModels: ['lm-studio::qwen3-14b'],
    })
    // Core 偏好里只剩它自己的键 —— 两处真相是这类 bug 的来源
    const corePrefs = JSON.parse(readFileSync(path.join(root, 'core', 'preferences.json'), 'utf8'))
    expect(corePrefs).toEqual({ 'ui.theme': 'light' })
  })

  it('目标已存在 → 什么都不动（绝不覆盖用户后来改过的那份）', () => {
    mkdirSync(path.join(root, 'plugin', 'models'), { recursive: true })
    writeFileSync(
      path.join(root, 'plugin', 'models', 'credentials.json'),
      JSON.stringify({ cred_new: { id: 'cred_new', value: 'later' } }),
      'utf8',
    )
    writeFileSync(
      path.join(root, 'plugin', 'models', 'preferences.json'),
      JSON.stringify({ connectedVendors: ['ollama'], vendorOverrides: [], enabledModels: [] }),
      'utf8',
    )
    writeCore('credentials.json', { cred_old: { id: 'cred_old', value: 'old' } })
    writeCore('preferences.json', { llm: { connectedVendors: ['lm-studio'] } })

    const done = migratePluginOwnedData(root)

    expect(done).toEqual([])
    expect(readModels('credentials.json')).toEqual({ cred_new: { id: 'cred_new', value: 'later' } })
    expect(readModels('preferences.json')).toEqual({
      connectedVendors: ['ollama'],
      vendorOverrides: [],
      enabledModels: [],
    })
    // Core 那两份原样留着（用户的东西不该被迁移顺手删掉）
    expect(existsSync(path.join(root, 'core', 'credentials.json'))).toBe(true)
  })

  it('幂等：跑两次与跑一次同结果（重复启动不会来回搬）', () => {
    writeCore('credentials.json', { cred_1: { id: 'cred_1', value: 'sk-x' } })
    writeCore('preferences.json', { llm: { connectedVendors: ['lm-studio'] } })

    const first = migratePluginOwnedData(root)
    const second = migratePluginOwnedData(root)

    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual([])
    expect(readModels('preferences.json')).toEqual({
      connectedVendors: ['lm-studio'],
      vendorOverrides: [],
      enabledModels: [],
    })
  })

  it('凭据文件坏掉 → 源文件留着并报 WARN（不删、不吞，下次再试）', () => {
    mkdirSync(path.join(root, 'core'), { recursive: true })
    writeFileSync(path.join(root, 'core', 'credentials.json'), '{ 坏掉的 json', 'utf8')

    const done = migratePluginOwnedData(root)

    expect(existsSync(path.join(root, 'core', 'credentials.json'))).toBe(true)
    expect(existsSync(path.join(root, 'plugin', 'models', 'credentials.json'))).toBe(false)
    expect(done.join()).toContain('WARN')
  })

  it('没有 llm 段的老偏好 → 不动它（这份 Core 偏好与本迁移无关）', () => {
    writeCore('preferences.json', { 'ui.theme': 'dark' })

    expect(migratePluginOwnedData(root)).toEqual([])
    expect(existsSync(path.join(root, 'plugin', 'models', 'preferences.json'))).toBe(false)
  })
})