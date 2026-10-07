/**
 * 引导配置 `<应用根>/ost.config.json` 测试 —— 数据目录这个设置的读、写、优先级。
 *
 * 这条链路为什么值得单独一组测试：
 * 它是**唯一**能改数据目录的地方，而改错了的表现是「下次启动数据不见了」——
 * 一个测试都覆盖不到的静默故障。三件事必须钉死：
 * 1. 应用根怎么反推（数据根跟着应用根，不跟着 cwd 漂）
 * 2. 优先级 CLI > env > 配置文件 > 缺省（顺序错了 = 命令行被配置盖掉）
 * 3. `/api/config` 的写路径：写得进、恢复得掉、坏 body 拒得掉
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appRoot, bootConfigFile, readBootConfig, writeBootConfig } from '../src/config'
import { loadConfig } from '../src/config/config'
import { Bus } from '../src/bus/bus'
import { SseBridge } from '../src/sse-bridge/server'

/** 造一个「布局正确」的应用根：`<root>/core/package.json` + 入口路径 */
function makeAppRoot(): { root: string; entry: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
  mkdirSync(path.join(root, 'core', 'dist'), { recursive: true })
  writeFileSync(
    path.join(root, 'core', 'package.json'),
    JSON.stringify({ name: '@osteosome/core', version: '9.9.9' }),
  )
  return { root, entry: path.join(root, 'core', 'dist', 'main.js') }
}

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清不掉就算了，tmp 目录本来就会被系统回收 */
    }
  }
})

describe('appRoot：应用根从入口反推', () => {
  it('core/dist/main.js → 上两级就是应用根（不看 cwd）', () => {
    const { root, entry } = makeAppRoot()
    cleanups.push(root)
    expect(appRoot(entry)).toBe(root)
    expect(appRoot(entry, () => false)).toBeUndefined()
  })

  it('上一级不是 @osteosome/core → 不猜，返回 undefined', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    mkdirSync(path.join(root, 'dist'), { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'something-else' }))
    expect(appRoot(path.join(root, 'dist', 'main.js'))).toBeUndefined()
    // 入口为空 / 指向不存在的 package.json
    expect(appRoot('')).toBeUndefined()
    expect(appRoot(path.join(root, 'nope', 'main.js'))).toBeUndefined()
  })
})

describe('readBootConfig：坏配置不能把人锁在门外', () => {
  it('缺文件 → {}（这是常态）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    expect(readBootConfig(bootConfigFile(root))).toEqual({})
  })

  it('JSON 非法 / 不是对象 / dataDir 类型不对 → 丢掉这一项，不抛', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    const file = bootConfigFile(root)
    for (const bad of ['{oops', '[]', '"str"', JSON.stringify({ dataDir: 42 }), JSON.stringify({ dataDir: '   ' })]) {
      writeFileSync(file, bad)
      expect(readBootConfig(file)).toEqual({})
    }
    writeFileSync(file, JSON.stringify({ dataDir: '  D:/x  ', other: 1 }))
    expect(readBootConfig(file)).toEqual({ dataDir: 'D:/x' })
  })

  it('writeBootConfig：删掉的字段真的消失，不认识的字段保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    const file = bootConfigFile(root)
    writeFileSync(file, JSON.stringify({ futureKey: 'kept' }))
    writeBootConfig(file, { dataDir: '/a/b' })
    expect(readBootConfig(file)).toEqual({ dataDir: '/a/b' })
    writeBootConfig(file, { dataDir: undefined })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ futureKey: 'kept' })
  })
})

describe('loadConfig：数据根来源优先级 CLI > env > 引导配置 > 缺省', () => {
  it('没配引导配置 → 缺省 = <应用根>/userData，且标成缺省', () => {
    const { root, entry } = makeAppRoot()
    cleanups.push(root)
    const cfg = loadConfig([], {}, '/somewhere/else', process.execPath, entry)
    expect(cfg.dataDir).toBe(path.join(root, 'userData'))
    expect(cfg.dataDirSource).toBe('default')
    expect(cfg.dataDirIsDefault).toBe(true)
    expect(cfg.defaultDataDir).toBe(cfg.dataDir)
    expect(cfg.configFilePath).toBe(path.join(root, 'ost.config.json'))
    // 应用根由入口反推 —— cwd 不参与这个决定
    expect(cfg.dataDir.startsWith('/somewhere/else')).toBe(false)
  })

  it('引导配置给了 dataDir → 用它；相对路径按应用根解析；标成「非缺省」（不触发旧目录迁移）', () => {
    const { root, entry } = makeAppRoot()
    cleanups.push(root)
    writeFileSync(bootConfigFile(root), JSON.stringify({ dataDir: 'alt-data' }))
    const cfg = loadConfig([], {}, '/somewhere/else', process.execPath, entry)
    expect(cfg.dataDir).toBe(path.join(root, 'alt-data'))
    expect(cfg.dataDirSource).toBe('config')
    expect(cfg.dataDirIsDefault).toBe(false)
    expect(cfg.defaultDataDir).toBe(path.join(root, 'userData'))
  })

  it('OST_DATA 盖过配置文件，--data 盖过 OST_DATA', () => {
    const { root, entry } = makeAppRoot()
    cleanups.push(root)
    writeFileSync(bootConfigFile(root), JSON.stringify({ dataDir: 'from-config' }))

    const fromEnv = loadConfig([], { OST_DATA: path.join(root, 'from-env') }, '/somewhere/else', process.execPath, entry)
    expect(fromEnv.dataDir).toBe(path.join(root, 'from-env'))
    expect(fromEnv.dataDirSource).toBe('env')

    const fromCli = loadConfig(
      ['--data', path.join(root, 'from-cli')],
      { OST_DATA: path.join(root, 'from-env') },
      '/somewhere/else',
      process.execPath,
      entry,
    )
    expect(fromCli.dataDir).toBe(path.join(root, 'from-cli'))
    expect(fromCli.dataDirSource).toBe('cli')
    expect(fromCli.dataDirIsDefault).toBe(false)
  })

  it('引导配置坏了 → 当没配，照常启动（坏文件不能拦住启动）', () => {
    const { root, entry } = makeAppRoot()
    cleanups.push(root)
    writeFileSync(bootConfigFile(root), '{ this is not json')
    const cfg = loadConfig([], {}, '/somewhere/else', process.execPath, entry)
    expect(cfg.dataDirSource).toBe('default')
    expect(cfg.dataDir).toBe(path.join(root, 'userData'))
  })

  it('入口不在预期布局 → 应用根退回 cwd（仍有一条可用的缺省路径）', () => {
    const cfg = loadConfig([], {}, '/somewhere/else', process.execPath, path.join('/other', 'entry.js'))
    expect(cfg.dataDir).toBe(path.resolve('/somewhere/else', 'userData'))
    expect(cfg.dataDirSource).toBe('default')
  })
})

describe('GET/PUT /api/config', () => {
  let bridge: SseBridge | undefined

  async function start(root: string): Promise<string> {
    const configFilePath = bootConfigFile(root)
    const dataDir = path.join(root, 'userData')
    mkdirSync(dataDir, { recursive: true })
    bridge = new SseBridge({
      bus: new Bus(),
      config: {
        dataDir,
        distDir: path.join(root, 'dist'),
        port: 0,
        configFilePath,
        dataDirSource: 'default',
        defaultDataDir: dataDir,
      },
    })
    const port = await bridge.listen(0)
    return `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    await bridge?.close()
    bridge = undefined
  })

  it('写得进 / 读得回 / 恢复得掉，且每一步都明说「要重启才生效」', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    const base = await start(root)
    const file = bootConfigFile(root)

    // 没配过 → 只回路径
    const before = await fetch(`${base}/api/config`)
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual({ configFilePath: file })

    // 写（相对路径按应用根解析，目录就地建出来）
    const put = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir: 'alt-data' }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      ok: true,
      dataDir: path.join(root, 'alt-data'),
      restartRequired: true,
    })
    expect(existsSync(path.join(root, 'alt-data'))).toBe(true)

    // 读回
    const after = await fetch(`${base}/api/config`)
    expect(await after.json()).toEqual({
      dataDir: path.join(root, 'alt-data'),
      configFilePath: file,
    })

    // 恢复缺省 → 字段真的消失
    const reset = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir: null }),
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ ok: true, dataDir: null, restartRequired: true })
    expect(readBootConfig(file)).toEqual({})
  })

  it('坏输入拒得掉：非对象 / dataDir 不是字符串 / 空串 / 方法不对', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    const base = await start(root)
    const put = (body: string) =>
      fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

    expect((await put('[1,2]')).status).toBe(400)
    expect((await put(JSON.stringify({ dataDir: 42 }))).status).toBe(400)
    expect((await put(JSON.stringify({ dataDir: '   ' }))).status).toBe(400)
    expect((await put('not json')).status).toBe(400)
    expect((await fetch(`${base}/api/config`, { method: 'POST' })).status).toBe(405)
    // 一个字节都没写进去
    expect(readBootConfig(bootConfigFile(root))).toEqual({})
  })

  it('/api/info 把「当前值 / 来源 / 恢复默认会去哪 / 设置存在哪」一起交代清楚', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ost-app-'))
    cleanups.push(root)
    const base = await start(root)
    const info = await (await fetch(`${base}/api/info`)).json()
    expect(info).toEqual({
      dataDir: path.join(root, 'userData'),
      dataDirSource: 'default',
      defaultDataDir: path.join(root, 'userData'),
      configFilePath: bootConfigFile(root),
    })
  })
})
