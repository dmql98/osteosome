import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Bus } from '../src/bus/bus'
import { SseBridge } from '../src/sse-bridge/server'
import { PluginRegistry } from '../src/service-manager/plugin-registry-runtime'
import type { CoreConfig } from '../src/config'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * P3：Core 伺服插件 WebUI 产物（`GET /plugins/<id>/ui/*`）。
 *
 * 这个测试盯的是三件事：
 * 1. **能取到**：index.html / 带哈希的 asset / hash 视图入口 / 目录尾斜杠
 * 2. **取不到时说得清**：停用、未构建、没声明 UI、版本不合 —— 全是 404 而不是白屏
 * 3. **绝不越界**：路径穿越被挡住，且 plugin-ui 路由在 static.ts 兜底**之前**生效
 *    （顺序反了的话，下面所有 404 用例都会变成「静默回 index.html」，测不出来）
 */
let pluginsDir: string
let dataDir: string
let server: SseBridge
let port: number
let baseUrl: string

/** 造一个带 UI 产物的插件；`views` 与实际写入的 dist/ui 文件由调用方控制 */
function writePlugin(
  id: string,
  opts: {
    views?: { id: string; title: string; entry: string }[]
    coreCompatibility?: unknown
    writeUi?: boolean
    serviceId?: string
  } = {},
): void {
  const dir = path.join(pluginsDir, id)
  const serviceId = opts.serviceId ?? `${id}-svc`
  mkdirSync(path.join(dir, 'services', serviceId), { recursive: true })
  writeFileSync(
    path.join(dir, 'services', serviceId, 'service.json'),
    JSON.stringify({
      id: serviceId,
      version: '1.0.0',
      protocolVersion: '1.0.0',
      entry: 'node index.js',
      inject: [],
      publishes: [],
      subscribes: [],
    }),
  )
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      services: [serviceId],
      ...(opts.coreCompatibility ? { coreCompatibility: opts.coreCompatibility } : {}),
      ...(opts.views ? { ui: { views: opts.views } } : {}),
    }),
  )
  if (opts.writeUi !== false) {
    const uiDir = path.join(dir, 'dist', 'ui')
    mkdirSync(path.join(uiDir, 'assets'), { recursive: true })
    writeFileSync(path.join(uiDir, 'index.html'), `<!doctype html><title>${id}</title>`)
    writeFileSync(path.join(uiDir, 'assets', 'index-a1b2c3.js'), `console.log('${id}')`)
  }
}

beforeAll(async () => {
  pluginsDir = mkdtempSync(path.join(tmpdir(), 'ost-p3-ui-plugins-'))
  dataDir = mkdtempSync(path.join(tmpdir(), 'ost-p3-ui-data-'))

  writePlugin('chat', {
    views: [
      { id: 'chat', title: '对话', entry: 'index.html' },
      { id: 'timeline', title: '时间线', entry: 'index.html#timeline' },
    ],
  })
  // 声明了 UI 但没构建 dist/ui（P5 之前真实存在的那种状态）
  writePlugin('unbuilt', {
    views: [{ id: 'main', title: '主', entry: 'index.html' }],
    writeUi: false,
  })
  // 纯服务插件：合法地不声明 ui
  writePlugin('headless')
  // 声明了 UI 也构建了，但要一个它满足不了的 Core 版本
  writePlugin('future', {
    views: [{ id: 'main', title: '主', entry: 'index.html' }],
    coreCompatibility: { min: '9.0.0', max: '10.0.0' },
  })

  const bus = new Bus()
  const registry = new PluginRegistry(bus, {
    pluginsDir,
    dataDir,
    coreVersion: '0.1.0',
    listServiceStates: () => new Map(),
    // 只有 `chat` 与 `unbuilt` 可用：`future` 版本不合、`off` 用来验停用即 404
    disabledIds: () => new Set(['headless']),
    controlService: async () => undefined,
  })

  server = new SseBridge({
    bus,
    config: { port: 0, dataDir, distDir: path.join(dataDir, 'distClient') } as unknown as CoreConfig,
    plugins: registry,
  })
  port = await server.listen(0)
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await server?.close()
  rmSync(pluginsDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('GET /plugins/<id>/ui/* · 取得到', () => {
  test('index.html：无尾斜杠与有尾斜杠等价（前端不必关心那个斜杠）', async () => {
    for (const p of ['/plugins/chat/ui', '/plugins/chat/ui/']) {
      const res = await fetch(`${baseUrl}${p}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(await res.text()).toContain('<title>chat</title>')
    }
  })

  test('hash 视图的入口就是同一个 index.html —— Core 不参与路由', async () => {
    // '#' 之后浏览器根本不会发给服务器：这里证明服务端看到的请求形态与无 hash 时一致
    const res = await fetch(`${baseUrl}/plugins/chat/ui/index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>chat</title>')
  })

  test('asset：正确的 Content-Type + 长缓存（文件名带内容哈希）', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/assets/index-a1b2c3.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toContain('chat')
  })

  test('index.html 走 no-cache：插件升级后不能被旧壳指着已删除的 chunk', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/`)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  test('未知路径回 index.html（hash 路由下几乎不会走到，但白屏更糟）', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/does/not/exist`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>chat</title>')
  })

  test('HEAD 可用且不返回体', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(
      Buffer.byteLength('<!doctype html><title>chat</title>'),
    ))
  })
})

describe('GET /plugins/<id>/ui/* · 取不到时必须说清', () => {
  test('未构建 → 404（不是占位页）', async () => {
    const res = await fetch(`${baseUrl}/plugins/unbuilt/ui/`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toContain('ui not built')
  })

  test('纯服务插件（没声明 ui）→ 404', async () => {
    const res = await fetch(`${baseUrl}/plugins/headless/ui/`)
    expect(res.status).toBe(404)
  })

  test('Core 版本不满足 coreCompatibility → 404，界面也不伺服', async () => {
    const res = await fetch(`${baseUrl}/plugins/future/ui/`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toContain('9.0.0')
  })

  test('不存在的插件 → 404', async () => {
    expect((await fetch(`${baseUrl}/plugins/nope/ui/`)).status).toBe(404)
  })

  test('非 GET/HEAD → 405', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('/plugins/<id> 与 /plugins/<id>/xxx 都不是 UI 路由 → 404', async () => {
    // Core 接管了**整个** `/plugins/` 前缀（而不是只接管 `/plugins/*/ui/`）：
    // 那里没有任何 Core 自己的资源，客户端也只用 hash 路由（不会请求 `/plugins/chat`），
    // 所以「回 404」比「漏给 static 兜底回 index.html」更诚实 —— 后者会让一个
    // 打错的地址看起来像「这个插件存在」，是典型的假成功。
    for (const p of ['/plugins/chat', '/plugins/chat/other']) {
      const res = await fetch(`${baseUrl}${p}`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error?: string }).error).toBe('not found')
    }
  })
})

describe('GET /plugins/<id>/ui/* · 不许越界', () => {
  test('编码后的穿越（%2e%2e%2f）→ 403，这才是前缀检查真正在挡的东西', async () => {
    // 为什么不用裸 `../`：Node/浏览器的 URL 解析会**先**把 `/plugins/chat/ui/../../..`
    // 规范化成 `/etc/passwd`，请求根本到不了插件 UI 路由（于是被 static 的占位页接走，
    // 200 + 一段 HTML）。那种「穿越」测不到 Core 的任何判定 —— 它早就被规范化掉了。
    // 编码后的 `%2f` 不会被当作路径分隔符规范化，所以能活到 handler 里，
    // 也正是真实攻击（某些代理会解码一次再转发）会用的形态。
    const res = await fetch(
      `${baseUrl}/plugins/chat/ui/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd`,
    )
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('root:')
  })

  test('裸 ../ 会被 URL 规范化先吃掉：拿不到任何文件内容', async () => {
    // 断言的是「安全」而不是「某个状态码」：这条路径最终落在 static 的占位页上
    //（200 + 说明文字），没有文件内容 —— 记在这里是为了说明它与上一条的区别，
    // 以及为什么上一条才是有效的回归。
    const res = await fetch(`${baseUrl}/plugins/chat/ui/../../../etc/passwd`)
    expect(await res.text()).not.toContain('root:')
  })

  test('穿越后仍在自己目录内时照常伺服（不能把 ../ 一律拒掉）', async () => {
    // 用 `%2e%2e` 而不是 `..`：fetch/浏览器会先把 URL 里的 `..` 规范化掉，
    // 那样测的就不是「服务端怎么判」而是「客户端怎么规范化」了。
    // `dist/ui/x/../index.html` 是合法的路径写法（少数 bundler 会产出），
    // 粗暴拒绝会让合法资源 404。
    const res = await fetch(`${baseUrl}/plugins/chat/ui/x/%2e%2e/index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>chat</title>')
  })

  test('不能借 ui 路由读到别的插件的产物', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/../../unbuilt/dist/ui/index.html`)
    expect([403, 404]).toContain(res.status)
  })

  test('别处网页用 fetch 来读 → 403（与 /api/* 同一套 Origin 白名单）', async () => {
    // iframe 嵌入不受影响：iframe/顶层导航按 Fetch 规范不带 Origin（上面所有用例都没带）
    const res = await fetch(`${baseUrl}/plugins/chat/ui/`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  test('同源 Origin 放行', async () => {
    const res = await fetch(`${baseUrl}/plugins/chat/ui/`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    })
    expect(res.status).toBe(200)
  })
})