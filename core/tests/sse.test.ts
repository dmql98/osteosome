/**
 * SseBridge 测试（P1a WS-4 测试矩阵）：
 * - topics 过滤 / 推流格式 / 心跳 / dispose / command 202 / 僵尸断开
 * - Origin 白名单 / preferences 往返 / static 占位与穿越 / health / config 解析
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../src/bus/bus'
import { loadConfig } from '../src/config/config'
import {
  DIST_MARKER,
  coreVersion,
  installRoot,
  migrateFlatLayout,
  migrateLegacyDataDir,
  userDataDir,
} from '../src/config/paths'
import { SseBridge } from '../src/sse-bridge/server'
import { PluginRegistry } from '../src/service-manager/plugin-registry-runtime'
import type { ServiceInfo } from '@osteosome/shared'

// ── helpers ──────────────────────────────────────

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`)
}

interface BridgeCtx {
  bus: Bus
  bridge: SseBridge
  port: number
  base: string
  dataDir: string
  distDir: string
}

async function startBridge(
  overrides: {
    heartbeatMs?: number
    zombieMs?: number
    listServices?: () => ServiceInfo[]
    plugins?: PluginRegistry
  } = {},
): Promise<BridgeCtx> {
  const root = mkdtempSync(path.join(tmpdir(), 'ost-sse-'))
  const dataDir = path.join(root, 'data')
  const distDir = path.join(root, 'dist')
  mkdirSync(dataDir, { recursive: true })

  const bus = new Bus()
  const bridge = new SseBridge({
    bus,
    config: { servicesDir: path.join(root, 'services'), dataDir, distDir, port: 0 },
    listServices: overrides.listServices,
    ...(overrides.heartbeatMs !== undefined ? { heartbeatMs: overrides.heartbeatMs } : {}),
    ...(overrides.zombieMs !== undefined ? { zombieMs: overrides.zombieMs } : {}),
    plugins: overrides.plugins,
  })
  const port = await bridge.listen(0)
  return {
    bus,
    bridge,
    port,
    base: `http://127.0.0.1:${port}`,
    dataDir,
    distDir,
  }
}

async function stopBridge(ctx: BridgeCtx | undefined): Promise<void> {
  if (!ctx) return
  await ctx.bridge.close().catch(() => undefined)
  // 根目录 = dataDir 的上级
  rmSync(path.dirname(ctx.dataDir), { recursive: true, force: true })
}

/** 打开 SSE 流并累积文本，提供等到条件为真的读取器 */
async function openSse(
  base: string,
  query = '',
): Promise<{
  text: () => string
  waitFor: (fn: (s: string) => boolean, timeoutMs?: number) => Promise<string>
  controller: AbortController
  close: () => void
}> {
  const controller = new AbortController()
  const res = await fetch(`${base}/events${query}`, { signal: controller.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')

  let buf = ''
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
    } catch {
      /* aborted */
    }
  })()

  return {
    text: () => buf,
    waitFor: async (fn, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (fn(buf)) return buf
        await new Promise((r) => setTimeout(r, 15))
      }
      throw new Error(`sse waitFor timeout; got: ${JSON.stringify(buf.slice(0, 500))}`)
    },
    controller,
    close: () => controller.abort(),
  }
}

// ── tests ────────────────────────────────────────

describe('loadConfig', () => {
  it('parses --services/--data/--dist/--port from argv', () => {
    const cfg = loadConfig(
      ['--services', 'svc', '--data', 'dat', '--dist', 'dst', '--port', '9999'],
      {},
      '/tmp/base',
    )
    expect(cfg.servicesDir).toBe(path.resolve('/tmp/base', 'svc'))
    expect(cfg.dataDir).toBe(path.resolve('/tmp/base', 'dat'))
    expect(cfg.distDir).toBe(path.resolve('/tmp/base', 'dst'))
    expect(cfg.port).toBe(9999)
  })

  it('supports --key=value form and env fallback with CLI precedence', () => {
    const cfg = loadConfig(['--port=1500'], { OST_PORT: '1400', OST_SERVICES: 'env-svc' }, '/tmp/base')
    expect(cfg.port).toBe(1500)
    expect(cfg.servicesDir).toBe(path.resolve('/tmp/base', 'env-svc'))
  })

  it('defaults port to 1420 and paths to repo-relative defaults; data goes to the USER dir', () => {
    const cfg = loadConfig([], {}, '/tmp/base')
    expect(cfg.port).toBe(1420)
    expect(cfg.distDir).toBe(path.resolve('/tmp/base', './dist/client'))
    // P1：服务目录**没有缺省**了 —— 没给 --services 时由 main.ts 从插件清单算
    expect('servicesDir' in cfg).toBe(false)
    // 数据根**不跟工作副本**：没给 --data 时落用户目录
    expect(cfg.dataDir).toBe(userDataDir())
    expect(path.isAbsolute(cfg.dataDir)).toBe(true)
    expect(cfg.dataDir.startsWith(path.resolve('/tmp/base'))).toBe(false)
    expect(cfg.dataDirIsDefault).toBe(true)
    // 没发行标记 → 不是发行版（开发跑）
    expect(cfg.installRoot).toBeUndefined()
  })

  it('给了 --data / OST_DATA → 相对 cwd 解析，且标记为「非缺省」（不触发迁移）', () => {
    const fromCli = loadConfig(['--data', 'dat'], {}, '/tmp/base')
    expect(fromCli.dataDir).toBe(path.resolve('/tmp/base', 'dat'))
    expect(fromCli.dataDirIsDefault).toBe(false)
    const fromEnv = loadConfig([], { OST_DATA: path.resolve('abs-data') }, '/tmp/base')
    expect(fromEnv.dataDir).toBe(path.resolve('abs-data'))
    expect(fromEnv.dataDirIsDefault).toBe(false)
  })

  it('rejects invalid port (fail fast)', () => {
    expect(() => loadConfig(['--port', 'abc'], {}, '/tmp/base')).toThrow(/invalid port/)
    expect(() => loadConfig(['--port', '70000'], {}, '/tmp/base')).toThrow(/invalid port/)
  })

  // ── S7：插件层开关 ──
  // 「不启用插件层」必须是一条**可用**的路径：core/tests 里有 17 个集成测试起真 Core
  // 只为拿某几个服务，若都得先装插件，测试就从「测被测物」变成「测插件装配」。
  it('缺省启用插件层，指向仓库内 ./plugins', () => {
    expect(loadConfig([], {}, '/tmp/base').pluginsDir).toBe(path.resolve('/tmp/base', './plugins'))
  })

  it('--plugins <dir> 指定插件目录', () => {
    expect(loadConfig(['--plugins', 'plg'], {}, '/tmp/base').pluginsDir).toBe(path.resolve('/tmp/base', 'plg'))
  })

  it('OST_PLUGINS 环境变量生效，CLI 优先', () => {
    expect(loadConfig([], { OST_PLUGINS: 'env-plg' }, '/tmp/base').pluginsDir).toBe(
      path.resolve('/tmp/base', 'env-plg'),
    )
    expect(loadConfig(['--plugins', 'cli-plg'], { OST_PLUGINS: 'env-plg' }, '/tmp/base').pluginsDir).toBe(
      path.resolve('/tmp/base', 'cli-plg'),
    )
  })

  it('`none` 或空串 = 显式关掉插件层（属性缺省而非 undefined 路径）', () => {
    // 用 'none' 而不是空串：shell 与测试里都更难误传
    expect('pluginsDir' in loadConfig(['--plugins', 'none'], {}, '/tmp/base')).toBe(false)
    expect('pluginsDir' in loadConfig(['--plugins', ''], {}, '/tmp/base')).toBe(false)
    expect('pluginsDir' in loadConfig([], { OST_PLUGINS: 'none' }, '/tmp/base')).toBe(false)
  })
})

/**
 * 数据根的**位置**本身也是行为：密钥搬错了家 = 用户丢配置或泄密钥。
 * 所以两条分支（各平台位置、旧目录迁移）都直接断在这个纯函数上。
 */
describe('用户级数据根', () => {
  it('Windows → %LOCALAPPDATA%\\osteosome；刻意不用 %APPDATA%（那会随域策略漫游）', () => {
    expect(userDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32')).toBe(
      path.join('C:\\Users\\u\\AppData\\Local', 'osteosome'),
    )
    // 只有 APPDATA 时退回它 —— 仍然在用户目录下，不落到 cwd
    expect(userDataDir({ APPDATA: 'D:\\Roam' }, 'C:\\Users\\u', 'win32')).toBe(path.join('D:\\Roam', 'osteosome'))
    // 都没有 → 用 home 拼，且**不是** cwd 相对
    expect(userDataDir({}, '/home/u', 'win32')).toBe(path.join('/home/u', 'AppData', 'Local', 'osteosome'))
  })

  it('非 Windows → $XDG_DATA_HOME/osteosome，退 ~/.local/share/osteosome', () => {
    expect(userDataDir({ XDG_DATA_HOME: '/home/u/share' }, '/home/u', 'linux')).toBe(
      path.join('/home/u/share', 'osteosome'),
    )
    // 空白值当没给 —— 否则 join 出来是 'osteosome' 相对路径，又回到「跟着 cwd 走」的坑
    expect(userDataDir({ XDG_DATA_HOME: '  ' }, '/home/u', 'linux')).toBe(
      path.join('/home/u', '.local', 'share', 'osteosome'),
    )
  })

  describe('旧 <cwd>/.data 的一次性迁移', () => {
    let root = ''
    let legacy = ''
    let target = ''

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'ost-migrate-'))
      legacy = path.join(root, '.data')
      target = path.join(root, 'user-data')
      mkdirSync(legacy)
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('缺省值 + 目标空 → 按三层布局搬运（旧的保留）', () => {
      writeFileSync(path.join(legacy, 'preferences.json'), '{"llm":{}}')
      writeFileSync(path.join(legacy, 'credentials.json'), '{"cred_1":{"id":"cred_1"}}')
      mkdirSync(path.join(legacy, 'sessions'))
      writeFileSync(path.join(legacy, 'sessions', 'index.json'), '[]')
      mkdirSync(target)

      const copied = migrateLegacyDataDir(target, root, true).sort()
      // Core 自己的进 core/，会话进它所属插件（chat-workbench）
      expect(copied).toEqual([
        'core/credentials.json',
        'core/preferences.json',
        'plugin/chat-workbench/sessions',
      ])
      expect(readFileSync(path.join(target, 'core', 'preferences.json'), 'utf8')).toBe('{"llm":{}}')
      expect(readFileSync(path.join(target, 'core', 'credentials.json'), 'utf8')).toBe('{"cred_1":{"id":"cred_1"}}')
      expect(readFileSync(path.join(target, 'plugin', 'chat-workbench', 'sessions', 'index.json'), 'utf8')).toBe('[]')
      // 复制不是移动：旧目录还在，用户确认前随时能回去拿
      expect(existsSync(path.join(legacy, 'preferences.json'))).toBe(true)
    })

    it('未登记的旧文件进 core/（那些是 Core 的日志之类）', () => {
      writeFileSync(path.join(legacy, 'core.out.log'), 'x')
      mkdirSync(target)
      expect(migrateLegacyDataDir(target, root, true)).toEqual(['core/core.out.log'])
      expect(existsSync(path.join(target, 'core', 'core.out.log'))).toBe(true)
    })

    it('目标已有数据 → 一个字节都不动（那可能是用户特意指过来的备份）', () => {
      writeFileSync(path.join(legacy, 'preferences.json'), '{"legacy":true}')
      mkdirSync(target)
      writeFileSync(path.join(target, 'preferences.json'), '{"mine":true}')

      expect(migrateLegacyDataDir(target, root, true)).toEqual([])
      expect(readFileSync(path.join(target, 'preferences.json'), 'utf8')).toBe('{"mine":true}')
    })

    it('显式 --data（isDefault=false）→ 不迁移；测试与 smoke 的临时目录因此不会被灌进本机密钥', () => {
      writeFileSync(path.join(legacy, 'credentials.json'), '{"cred_1":{}}')
      expect(migrateLegacyDataDir(target, root, false)).toEqual([])
      expect(existsSync(path.join(target, 'credentials.json'))).toBe(false)
    })

it('旧目录不存在 → 什么都不做（不建目录、不报错）', () => {
      const fresh = path.join(root, 'no-legacy')
      expect(migrateLegacyDataDir(target, fresh, true)).toEqual([])
      expect(existsSync(target)).toBe(false)
    })
  })

  /**
   * 同一个根里「扁平 → 三层」的迁移。
   *
   * 不做这一步的后果是**静默丢配置**：P0 时代写下的 `<dataDir>/preferences.json` 留在原地，
   * 而 P1 之后 Core 只读 `<dataDir>/core/preferences.json` —— 用户看到的是「全没了」，
   * 文件却好好地躺在磁盘上，最难自查的一种丢。
   */
  describe('扁平布局 → 三层布局（同一个根内）', () => {
    let dataDir = ''

    beforeEach(() => {
      dataDir = mkdtempSync(path.join(tmpdir(), 'ost-flat-'))
    })
    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('把根下的 preferences / credentials / sessions 搬进 core/ 与 plugin/<id>/', () => {
      writeFileSync(path.join(dataDir, 'preferences.json'), '{"ui.theme":"dark"}')
      writeFileSync(path.join(dataDir, 'credentials.json'), '{"cred_1":{"id":"cred_1"}}')
      mkdirSync(path.join(dataDir, 'sessions'))
      writeFileSync(path.join(dataDir, 'sessions', 'index.json'), '[]')

      expect(migrateFlatLayout(dataDir).sort()).toEqual([
        'core/credentials.json',
        'core/preferences.json',
        'plugin/chat-workbench/sessions',
      ])
      expect(readFileSync(path.join(dataDir, 'core', 'preferences.json'), 'utf8')).toBe('{"ui.theme":"dark"}')
      // 源仍在（不删）—— 迁错了还能回去拿
      expect(existsSync(path.join(dataDir, 'preferences.json'))).toBe(true)
    })

    it('已经是新布局 → 什么都不做（幂等）', () => {
      mkdirSync(path.join(dataDir, 'core'), { recursive: true })
      writeFileSync(path.join(dataDir, 'core', 'preferences.json'), '{}')
      expect(migrateFlatLayout(dataDir)).toEqual([])
    })

    it('什么都没有 → 返回空数组，不建 core/ 目录', () => {
      expect(migrateFlatLayout(dataDir)).toEqual([])
      expect(existsSync(path.join(dataDir, 'core'))).toBe(false)
    })
  })

  /**
   * 发行版判据（`installRoot`）。
   *
   * 这条判据错了的代价是**开发期与发行期数据分叉**：用户装完发现密钥「不见了」，
   * 而文件就在 exe 旁边的 userData/ 里 —— 极难自查。所以它必须有测试。
   */
  describe('发行版判据（exe 同级的 .osteosome-dist）', () => {
    let root = ''
    let exeDir = ''
    let fakeExe = ''

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'ost-dist-'))
      exeDir = path.join(root, 'app')
      mkdirSync(exeDir, { recursive: true })
      fakeExe = path.join(exeDir, 'osteosome.exe')
      writeFileSync(fakeExe, '')
    })
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('没有标记 → 不是发行版（开发跑），installRoot 为 undefined', () => {
      expect(installRoot(fakeExe)).toBeUndefined()
    })

    it('有标记 → 安装根 = <exe 目录>/osteosome', () => {
      writeFileSync(path.join(exeDir, DIST_MARKER), '')
      expect(installRoot(fakeExe)).toBe(path.join(exeDir, 'osteosome'))
    })

    it('标记存在 → dataDir 与 pluginsDir 都落在安装根下（发行物自包含）', () => {
      writeFileSync(path.join(exeDir, DIST_MARKER), '')
      const cfg = loadConfig([], {}, root, fakeExe)
      expect(cfg.installRoot).toBe(path.join(exeDir, 'osteosome'))
      expect(cfg.dataDir).toBe(path.join(exeDir, 'osteosome', 'userData'))
      expect(cfg.pluginsDir).toBe(path.join(exeDir, 'osteosome', 'plugins'))
    })

it('发行版下显式 --data / --plugins 仍然优先（部署者另有安排）', () => {
      writeFileSync(path.join(exeDir, DIST_MARKER), '')
      const cfg = loadConfig(['--data', 'd', '--plugins', 'p'], {}, root, fakeExe)
      expect(cfg.dataDir).toBe(path.resolve(root, 'd'))
      expect(cfg.pluginsDir).toBe(path.resolve(root, 'p'))
    })
  })

  /**
   * Core 自己的版本号（P2）—— `coreCompatibility` 的判定输入。
   *
   * 退 `0.0.0` 是刻意的**可见的坏**：它会让所有声明 `min: "0.1.0"` 的插件被判为
   * 「不满足」，即被拦住并打出警告 —— 而猜一个好看的版本会让插件在错误的 Core 上装上，
   * 症状是运行期的怪问题。所以这里断的是「读不到就诚实退 0.0.0」。
   */
  describe('Core 自己的版本号', () => {
    let root = ''

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'ost-ver-'))
    })
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('从入口旁的 package.json 读（core/dist/main.js → core/package.json）', () => {
      mkdirSync(path.join(root, 'dist'), { recursive: true })
      writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: '@osteosome/core', version: '1.2.3' }),
      )
      expect(coreVersion(path.join(root, 'dist', 'main.js'))).toBe('1.2.3')
    })

    it('读不到 / 不是 core 的包 / 版本为空 → 退 0.0.0（不猜）', () => {
      expect(coreVersion(path.join(root, 'nope', 'main.js'))).toBe('0.0.0')
      expect(coreVersion('')).toBe('0.0.0')
      mkdirSync(path.join(root, 'dist'), { recursive: true })
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }))
      expect(coreVersion(path.join(root, 'dist', 'main.js'))).toBe('0.0.0')
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@osteosome/core', version: '' }))
      expect(coreVersion(path.join(root, 'dist', 'main.js'))).toBe('0.0.0')
    })

    // 刻意**不**在这里断「本仓库读得出来」：那依赖 process.argv[1] 指向 core/dist/main.js，
    // 而 vitest 下 argv[1] 是它自己。真路径由 smoke 覆盖（它就是 `node core/dist/main.js` 起的）。
  })
})

describe('SseBridge', () => {
  let ctx: BridgeCtx | undefined

  beforeEach(() => {
    ctx = undefined
  })

  afterEach(async () => {
    await stopBridge(ctx)
    ctx = undefined
  })

  it('GET /health returns ok + uptime + services list', async () => {
    const services: ServiceInfo[] = [
      { id: 'hello', version: '1.0.0', status: 'ready', restartCount: 0 },
    ]
    ctx = await startBridge({ listServices: () => services })
    const res = await fetch(`${ctx.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; uptime: number; services: ServiceInfo[] }
    expect(body.ok).toBe(true)
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(body.services).toEqual(services)
  })

  it('SSE filters by ?topics= and pushes event: message with topic in body', async () => {
    ctx = await startBridge()
    const sse = await openSse(ctx.base, '?topics=hello.**')

    ctx.bus.publish('hello.command.started', { ts: Date.now(), source: 'test', requestId: 'r1', text: 'hi' })
    ctx.bus.publish('service.ready', { ts: Date.now(), source: 'test', serviceId: 'other', version: '1' })
    await flushMicrotasks()

    const text = await sse.waitFor((s) => s.includes('event: message'))
    // 过滤生效：hello 命中，service 不出现
    expect(text).toContain('hello.command.started')
    expect(text).not.toContain('service.ready')
    // 推流格式：event: message + data JSON 带 topic
    const lines = text.split('\n')
    const eventIdx = lines.findIndex((l) => l === 'event: message')
    expect(eventIdx).toBeGreaterThanOrEqual(0)
    expect(lines[eventIdx + 1]).toMatch(/^data: \{/)
    const dataLine = lines[eventIdx + 1].slice('data: '.length)
    const parsed = JSON.parse(dataLine) as { topic: string; payload: Record<string, unknown> }
    expect(parsed.topic).toBe('hello.command.started')
    expect(parsed.payload).toMatchObject({ requestId: 'r1', text: 'hi' })
    expect(typeof parsed.payload.ts).toBe('number')

    sse.close()
  })

  it('SSE without topics receives all events', async () => {
    ctx = await startBridge()
    const sse = await openSse(ctx.base)

    ctx.bus.publish('service.ready', { ts: Date.now(), source: 'test', serviceId: 'a', version: '1' })
    ctx.bus.publish('hello.command.executed', { ts: Date.now(), source: 'test', requestId: 'r', echo: 'x' })
    await flushMicrotasks()

    const text = await sse.waitFor((s) => s.includes('hello.command.executed'))
    expect(text).toContain('service.ready')

    sse.close()
  })

  it('SSE sends heartbeat comment lines', async () => {
    ctx = await startBridge({ heartbeatMs: 40 })
    const sse = await openSse(ctx.base)
    await sse.waitFor((s) => s.includes(': heartbeat'), 2000)
    sse.close()
  })

  it('disposing on close stops delivery and decrements connectionCount', async () => {
    ctx = await startBridge()
    const sse = await openSse(ctx.base, '?topics=t.**')
    await waitFor(() => ctx!.bridge.connectionCount === 1)

    ctx.bus.publish('t.a', { n: 1 })
    await sse.waitFor((s) => s.includes('"t.a"') || s.includes('t.a'))

    // 关闭连接 → dispose 订阅
    sse.close()
    await waitFor(() => ctx!.bridge.connectionCount === 0)

    // 关闭后 publish 不再推到该连接（连接已死，无异常即可）
    ctx.bus.publish('t.a', { n: 2 })
    await flushMicrotasks()
    expect(ctx.bridge.connectionCount).toBe(0)
  })

  it('POST /api/command returns 202 and the payload reaches the bus', async () => {
    ctx = await startBridge()
    let got: Record<string, unknown> | undefined
    ctx.bus.subscribe('hello.command', (p) => {
      got = p
    })

    const res = await fetch(`${ctx.base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'hello.command', payload: { requestId: 'r9', text: 'yo' } }),
    })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)

    await waitFor(() => got !== undefined)
    expect(got).toMatchObject({ requestId: 'r9', text: 'yo' })
  })

  it('POST /api/command rejects event topics', async () => {
    ctx = await startBridge()
    const res = await fetch(`${ctx.base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'service.ready', payload: { serviceId: 'fake' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('not a command')
  })

  it('POST /api/command rejects invalid body with 400', async () => {
    ctx = await startBridge()
    const missingTopic = await fetch(`${ctx.base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: {} }),
    })
    expect(missingTopic.status).toBe(400)

    const badJson = await fetch(`${ctx.base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(badJson.status).toBe(400)
  })

  it('Origin whitelist: blocks foreign origins on /events and /api/*, allows null/missing/self', async () => {
    ctx = await startBridge()
    const port = ctx.port

    // 外站 Origin → 403
    const evilEvents = await fetch(`${ctx.base}/events`, {
      headers: { Origin: 'http://evil.example' },
    })
    expect(evilEvents.status).toBe(403)
    evilEvents.body?.cancel().catch(() => undefined)

    const evilCmd = await fetch(`${ctx.base}/api/command`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'hello.command', payload: {} }),
    })
    expect(evilCmd.status).toBe(403)

    const evilPrefs = await fetch(`${ctx.base}/api/preferences`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(evilPrefs.status).toBe(403)

    // 无 Origin（Node fetch 默认）→ 放行
    const noOrigin = await fetch(`${ctx.base}/health`)
    expect(noOrigin.status).toBe(200)

    // Origin: null → 放行
    const nullOrigin = await fetch(`${ctx.base}/api/preferences`, {
      headers: { Origin: 'null' },
    })
    expect(nullOrigin.status).toBe(200)

    // 自身 127.0.0.1 / localhost → 放行
    const selfIp = await fetch(`${ctx.base}/api/preferences`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    })
    expect(selfIp.status).toBe(200)

    const selfLh = await fetch(`${ctx.base}/api/preferences`, {
      headers: { Origin: `http://localhost:${port}` },
    })
    expect(selfLh.status).toBe(200)

    // 自身 Origin 打开 SSE 也放行
    const controller = new AbortController()
    const okSse = await fetch(`${ctx.base}/events`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
      signal: controller.signal,
    })
    expect(okSse.status).toBe(200)
    controller.abort()
    okSse.body?.cancel().catch(() => undefined)
  })

  it('/api/preferences GET/PUT roundtrip persists to dataDir JSON', async () => {
    ctx = await startBridge()

    // 缺省 → {}
    const before = await fetch(`${ctx.base}/api/preferences`)
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual({})

    // PUT
    const put = await fetch(`${ctx.base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', locale: 'zh-CN' }),
    })
    expect(put.status).toBe(200)

    // GET 回读
    const after = await fetch(`${ctx.base}/api/preferences`)
    expect(await after.json()).toEqual({ theme: 'dark', locale: 'zh-CN' })

    // 拒绝非对象 body
    const bad = await fetch(`${ctx.base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    })
    expect(bad.status).toBe(400)
  })

  it('static: serves placeholder when distDir missing, serves file when present, blocks traversal', async () => {
    ctx = await startBridge()

    // distDir 不存在 → 占位 index.html
    const placeholder = await fetch(`${ctx.base}/`)
    expect(placeholder.status).toBe(200)
    expect(placeholder.headers.get('content-type')).toContain('text/html')
    expect(await placeholder.text()).toContain('Osteosome Core')

    // 建 dist + 文件 → 直接 serve
    mkdirSync(ctx.distDir, { recursive: true })
    writeFileSync(path.join(ctx.distDir, 'index.html'), '<h1>app</h1>')
    writeFileSync(path.join(ctx.distDir, 'app.js'), 'console.log(1)')
    const served = await fetch(`${ctx.base}/`)
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('<h1>app</h1>')
    const js = await fetch(`${ctx.base}/app.js`)
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(await js.text()).toBe('console.log(1)')

    // 路径穿越 → 403
    const traverse = await fetch(`${ctx.base}/..%2F..%2Fetc%2Fpasswd`)
    expect(traverse.status).toBe(403)
  })

  it('zombie: disconnects after zombieMs with no successful write (补强 ②)', async () => {
    // 心跳极长（不会刷 lastOkAt），僵尸阈值 80ms → 应主动断
    ctx = await startBridge({ heartbeatMs: 60_000, zombieMs: 80 })
    const sse = await openSse(ctx.base)
    await waitFor(() => ctx!.bridge.connectionCount === 1)
    // 不 publish、不心跳 → 80ms 后僵尸断开
    await waitFor(() => ctx!.bridge.connectionCount === 0, 2000)
    expect(ctx.bridge.connectionCount).toBe(0)
    sse.close()
  })

  it('SSE with heartbeat keeps connection alive past zombie threshold', async () => {
    ctx = await startBridge({ heartbeatMs: 30, zombieMs: 100 })
    const sse = await openSse(ctx.base)
    await waitFor(() => ctx!.bridge.connectionCount === 1)
    // 心跳每 30ms 刷新 lastOkAt，100ms 阈值不会触发
    await new Promise((r) => setTimeout(r, 250))
    expect(ctx.bridge.connectionCount).toBe(1)
    sse.close()
    await waitFor(() => ctx!.bridge.connectionCount === 0, 2000)
  })

  it('unknown /api path → 404 after origin check; wrong method → 405', async () => {
    ctx = await startBridge()

    const notFound = await fetch(`${ctx.base}/api/nope`)
    expect(notFound.status).toBe(404)

    const wrongMethod = await fetch(`${ctx.base}/health`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)

    const wrongEvents = await fetch(`${ctx.base}/events`, { method: 'POST' })
    expect(wrongEvents.status).toBe(405)
    wrongEvents.body?.cancel().catch(() => undefined)
  })
})

describe('GET /api/plugins（S7-2a）', () => {
  let ctx: BridgeCtx | undefined

  afterEach(async () => {
    await stopBridge(ctx)
    ctx = undefined
  })

  function registryFor(dir: string | undefined): PluginRegistry {
    return new PluginRegistry(new Bus(), {
      pluginsDir: dir,
      dataDir: path.join(tmpdir(), 'ost-sse-userdata'),
      coreVersion: '0.1.0',
      listServiceStates: () => new Map(),
      controlService: async () => undefined,
    })
  }

  it('layer=disabled 时返回 200 + 空清单（显式关掉不是故障）', async () => {
    ctx = await startBridge({ plugins: registryFor(undefined) })
    const res = await fetch(`${ctx.base}/api/plugins`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { layer: string; plugins: unknown[] }
    expect(body.layer).toBe('disabled')
    expect(body.plugins).toEqual([])
  })

  it('目录不存在时 layer=missing-dir，且带 pluginsDir 供 UI 提示', async () => {
    ctx = await startBridge({ plugins: registryFor(path.join(tmpdir(), 'ost-no-such-plugins')) })
    const body = (await (await fetch(`${ctx.base}/api/plugins`)).json()) as {
      layer: string
      pluginsDir: string | null
    }
    expect(body.layer).toBe('missing-dir')
    expect(body.pluginsDir).toContain('ost-no-such-plugins')
  })

  it('未装配插件层时回 404，而不是假装返回空清单', async () => {
    ctx = await startBridge()
    const res = await fetch(`${ctx.base}/api/plugins`)
    expect(res.status).toBe(404)
  })

  it('非 GET -> 405', async () => {
    ctx = await startBridge({ plugins: registryFor(undefined) })
    const res = await fetch(`${ctx.base}/api/plugins`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
