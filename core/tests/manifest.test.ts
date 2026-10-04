import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest'
import { ManifestError, loadServices, loadServicesFrom, validateManifest } from '../src/service-manager/manifest'
import { coreDataDir, pluginDataDir, type Manifest } from '@osteosome/shared'

function validManifest(id = 'hello'): Manifest {
  return {
    id,
    version: '1.0.0',
    protocolVersion: '1.0.0',
    entry: 'node service.mjs',
    inject: [],
    publishes: ['hello.command.executed'],
    subscribes: ['hello.command'],
  }
}

describe('manifest validation', () => {
  it('accepts a valid manifest', () => {
    expect(validateManifest(validManifest())).toMatchObject({ id: 'hello' })
  })

  it('fails on missing required fields', () => {
    const { id, ...noId } = validManifest()
    expect(() => validateManifest(noId)).toThrow(ManifestError)
    const { publishes, ...noPublishes } = validManifest()
    expect(() => validateManifest(noPublishes)).toThrow(ManifestError)
  })

  it('fails on incompatible protocolVersion', () => {
    expect(() => validateManifest({ ...validManifest(), protocolVersion: '9.9.9' })).toThrow(
      /incompatible/,
    )
  })

  it('fails when publishes topic is not declared in EventMap', () => {
    expect(() =>
      validateManifest({ ...validManifest(), publishes: ['ghost.event'] }),
    ).toThrow(/not declared in shared EventMap/)
  })

  it('fails when subscribes topic touches neither events nor commands', () => {
    expect(() =>
      validateManifest({ ...validManifest(), subscribes: ['ghost.command'] }),
    ).toThrow(/not declared/)
  })

  it('accepts subscribes referencing a command topic', () => {
    expect(() => validateManifest(validManifest())).not.toThrow()
  })
})

describe('loadServices', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ost-manifest-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeService(id: string, manifest: unknown): string {
    const sub = path.join(dir, id)
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'service.json'), JSON.stringify(manifest))
    return sub
  }

  it('loads and validates all services in the directory', () => {
    writeService('hello', validManifest('hello'))
    writeService('other', validManifest('other'))
    const loaded = loadServices(dir)
    expect(loaded.map((s) => s.manifest.id).sort()).toEqual(['hello', 'other'])
  })

  it('aggregates failures across services (fail fast, all reported)', () => {
    writeService('bad', { ...validManifest('bad'), protocolVersion: '2.0.0' })
    writeService('bad2', { ...validManifest('bad2'), publishes: ['nope'] })
    expect(() => loadServices(dir)).toThrow(ManifestError)
    try {
      loadServices(dir)
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError)
      expect((err as ManifestError).reasons).toHaveLength(2)
    }
  })

  it('skips directories without service.json', () => {
    mkdirSync(path.join(dir, 'junk'))
    expect(loadServices(dir)).toHaveLength(0)
  })

  it('throws when the services dir does not exist', () => {
    expect(() => loadServices(path.join(dir, 'nope'))).toThrow(/not found/)
  })
})

/**
 * 多根服务发现（P1：服务住在 `plugins/<id>/services/<sid>/` 里，于是有多个根）。
 *
 * 这组测试守的是三个真实事故：漏掉一个插件的服务、两个插件抢同一个服务 id、
 * 以及「一个服务都没找到」被当成正常 —— 最后一个最危险，因为 Core 会安静地
 * 什么都不启动，界面表现为「所有服务都没了」而没有任何报错。
 */
describe('loadServicesFrom（多根 = 插件化）', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ost-multi-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeService(dir: string, id: string, manifest: unknown = validManifest(id)): string {
    const sub = path.join(dir, id)
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'service.json'), JSON.stringify(manifest))
    return dir
  }

  it('把多个根的服务合并（插件化后的正常形态）', () => {
    const a = writeService(path.join(root, 'models', 'services'), 'llm-provider-openai')
    const b = writeService(path.join(root, 'chat-workbench', 'services'), 'session')
    const loaded = loadServicesFrom([a, b])
    expect(loaded.map((s) => s.manifest.id).sort()).toEqual(['llm-provider-openai', 'session'])
  })

  it('不存在的根被跳过（插件可以合法地不带服务，如只有 UI 的 workbench）', () => {
    const a = writeService(path.join(root, 'models', 'services'), 'llm-provider-openai')
    const loaded = loadServicesFrom([a, path.join(root, 'workbench', 'services')])
    expect(loaded.map((s) => s.manifest.id)).toEqual(['llm-provider-openai'])
  })

  it('给了根却全都不存在 → 抛（装配没接上，不能安静地什么都不启动）', () => {
    expect(() => loadServicesFrom([path.join(root, 'nope')])).toThrow(/no services dir/)
  })

  it('压根没给根 → 返回空（还没构建任何插件 ≠ 装配写错了）', () => {
    // 这两件事必须分开：前者是正常的起步状态，后者是配置错误。
    // 混为一谈的后果是要么「刚 clone 下来就崩」，要么「路径写错却安静地什么都不启动」。
    expect(loadServicesFrom([])).toEqual([])
  })

  it('两个根声明同一个服务 id → 抛（否则后者静默覆盖前者，症状是「服务随机启动了一个」）', () => {
    const a = writeService(path.join(root, 'models', 'services'), 'dup')
    const b = writeService(path.join(root, 'chat-workbench', 'services'), 'dup')
    expect(() => loadServicesFrom([a, b])).toThrow(/duplicate service id 'dup'/)
  })
})

describe('插件数据根（P1）', () => {
  test('服务拿到的是「自己插件」的数据根，不是用户数据根', () => {
    // chat-workbench 的 session 与 llm 两个服务共享插件数据根；
    // models 的 provider 服务拿另一个 —— 这就是「一个插件一份数据」的直接后果
    const dataDir = path.join('D:', 'app', 'userData')
    expect(pluginDataDir(dataDir, 'chat-workbench')).toContain(path.join('plugin', 'chat-workbench'))
    expect(pluginDataDir(dataDir, 'models')).not.toBe(pluginDataDir(dataDir, 'chat-workbench'))
  })

  test('Core 自己的数据在 core/，与插件数据并列', () => {
    const dataDir = path.join('D:', 'app', 'userData')
    expect(coreDataDir(dataDir).replace(/[\\/]$/, '')).toBe(path.join(dataDir, 'core'))
    expect(coreDataDir(dataDir).startsWith(pluginDataDir(dataDir, 'models'))).toBe(false)
  })
})