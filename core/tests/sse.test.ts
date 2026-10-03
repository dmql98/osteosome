/**
 * SseBridge 测试（P1a WS-4 测试矩阵）：
 * - topics 过滤 / 推流格式 / 心跳 / dispose / command 202 / 僵尸断开
 * - Origin 白名单 / preferences 往返 / static 占位与穿越 / health / config 解析
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../src/bus/bus'
import { loadConfig } from '../src/config/config'
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

  it('defaults port to 1420 and paths to repo-relative defaults', () => {
    const cfg = loadConfig([], {}, '/tmp/base')
    expect(cfg.port).toBe(1420)
    expect(cfg.servicesDir).toBe(path.resolve('/tmp/base', './services'))
    expect(cfg.dataDir).toBe(path.resolve('/tmp/base', './.data'))
    expect(cfg.distDir).toBe(path.resolve('/tmp/base', './dist/client'))
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
      listServiceStates: () => new Map(),
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
