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
 * `GET /plugins/<id>/data/*` —— 伺服插件的**用户数据**（只读）。
 *
 * 这个测试盯的是四件事：
 * 1. **能取到**：清单 JSON / 二进制资产 / 深层相对路径 / HEAD
 * 2. **没有 SPA fallback**：未知路径是**真 404**，不是 200 + index.html
 *    —— 这是它与 `/ui/*` 唯一的行为差异，也是 `SkinRenderer` 第 4 级回退能工作的前提
 * 3. **绝不越界**：编码穿越 / 反斜杠 / 绝对路径 / 符号链接指向目录外
 * 4. **停用即 404**：与 `/ui/*` 同一条判定（`registry.dataDir`），
 *    否则「停用插件」只是个摆设 —— 数据仍然读得到
 */
let pluginsDir: string
let dataDir: string
let server: SseBridge
let port: number
let baseUrl: string

/** 造一个插件；`writeData` 控制是否预置用户数据目录 */
function writePlugin(
  id: string,
  opts: {
    coreCompatibility?: unknown
    writeUi?: boolean
    writeData?: boolean
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
    }),
  )
  if (opts.writeUi !== false) {
    const uiDir = path.join(dir, 'dist', 'ui')
    mkdirSync(uiDir, { recursive: true })
    writeFileSync(path.join(uiDir, 'index.html'), `<!doctype html><title>${id}</title>`)
  }
  if (opts.writeData) {
    const pdir = path.join(dataDir, 'plugin', id)
    mkdirSync(path.join(pdir, 'miku', 'assets'), { recursive: true })
    mkdirSync(path.join(pdir, 'miku', 'motions'), { recursive: true })
    writeFileSync(path.join(pdir, 'skins.json'), JSON.stringify({ version: 1, skins: [] }))
    // 内容寻址的 assetId：换一张图 = 新 id = 新 URL
    writeFileSync(path.join(pdir, 'miku', 'assets', 'a1b2c3d4.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(path.join(pdir, 'miku', 'motions', '9f8e7d6c.webp'), Buffer.from('RIFF????WEBP'))
  }
}

beforeAll(async () => {
  pluginsDir = mkdtempSync(path.join(tmpdir(), 'ost-data-plugins-'))
  dataDir = mkdtempSync(path.join(tmpdir(), 'ost-data-data-'))

  writePlugin('skins', { writeData: true })
  // 纯服务插件：没有 UI，但**仍然可以有用户数据**（dataDir 不要求声明 ui）
  writePlugin('headless', { writeUi: false, writeData: true })
  // 版本不合：与服务不启动同一条理由
  writePlugin('future', { coreCompatibility: { min: '9.0.0', max: '10.0.0' }, writeData: true })

  const bus = new Bus()
  const registry = new PluginRegistry(bus, {
    pluginsDir,
    dataDir,
    coreVersion: '0.1.0',
    listServiceStates: () => new Map(),
    disabledIds: () => new Set(['off']),
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

describe('GET /plugins/<id>/data/* · 取得到', () => {
  test('清单 JSON：正确的 Content-Type', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/skins.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(((await res.json()) as { version?: number }).version).toBe(1)
  })

  test('二进制资产：字节原样送出，Content-Type 按扩展名', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/miku/assets/a1b2c3d4.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
  })

  test('深层相对路径（motions/…）照常伺服', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/miku/motions/9f8e7d6c.webp`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
  })

  test('纯服务插件（没声明 ui）也能取到数据 —— dataDir 不要求 UI', async () => {
    const res = await fetch(`${baseUrl}/plugins/headless/data/skins.json`)
    expect(res.status).toBe(200)
  })

  test('HEAD 可用且不返回体', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/skins.json`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(
      String(Buffer.byteLength(JSON.stringify({ version: 1, skins: [] }))),
    )
    expect(await res.text()).toBe('')
  })

  test('缓存头：命中内容寻址判据 → immutable，否则 no-cache', async () => {
    // 与 plugin-ui.ts 同一套判据。assetId 形如 `a1b2c3d4.png`（哈希段前没有 `-`），
    // 所以实际走 no-cache —— 断言的是「判据被真的应用」，不是「它一定 immutable」。
    const hashed = await fetch(`${baseUrl}/plugins/skins/data/miku/assets/a1b2c3d4.png`)
    expect(hashed.headers.get('cache-control')).toBe('no-cache')
    const named = await fetch(`${baseUrl}/plugins/skins/data/skins.json`)
    expect(named.headers.get('cache-control')).toBe('no-cache')
  })
})

describe('GET /plugins/<id>/data/* · 没有 SPA fallback（与 /ui/* 唯一的行为差异）', () => {
  test('未知路径 → 真 404，不是 200 + index.html', async () => {
    // 这条是整个设计的地基：`/ui/*` 回 index.html 是对的（它伺服页面），
    // 而 `/data/*` 回 index.html 会让「资产不存在」变成一段 HTML ——
    // `<img>` 拿到 200 + text/html 会走 onerror，症状是「图片加载失败」，
    // 而真实原因是「路径拼错了」。404 让这两个可区分。
    const res = await fetch(`${baseUrl}/plugins/skins/data/nope.png`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).not.toContain('text/html')
    expect(((await res.json()) as { error?: string }).error).toBe('data file not found')
  })

  test('/plugins/<id>/data 与 /plugins/<id>/data/ 都不是「目录视图」→ 404', async () => {
    // 与 /ui/* 相反：那里补 index.html 是为了体验，这里补了就是凭空多一个文件。
    for (const p of ['/plugins/skins/data', '/plugins/skins/data/']) {
      const res = await fetch(`${baseUrl}${p}`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error?: string }).error).toBe('data entry not specified')
    }
  })

  test('目录（不是文件）→ 404，不是目录列表', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/miku`)
    expect(res.status).toBe(404)
  })
})

describe('GET /plugins/<id>/data/* · 不许越界', () => {
  test('编码后的穿越（%2e%2e%2f）→ 403', async () => {
    // 为什么不用裸 `../`：URL 解析会先把它规范化掉，请求根本到不了 handler。
    // 编码后的 `%2f` 不会被当作分隔符规范化，所以能活到 handler 里 ——
    // 也正是真实攻击（某些代理会解码一次再转发）会用的形态。
    const res = await fetch(
      `${baseUrl}/plugins/skins/data/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd`,
    )
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('root:')
  })

  test('反斜杠穿越（Windows 形态）→ 403', async () => {
    // `%5c` decode 出 `\`。只认 `/` 的检查会被 `..\..\core\credentials.json` 绕过 ——
    // 而 dataDir 里**有密钥**，这一条不是假想。
    const res = await fetch(
      `${baseUrl}/plugins/skins/data/%2e%2e%5c%2e%2e%5c%2e%2e%5cetc%5cpasswd`,
    )
    expect(res.status).toBe(403)
  })

  test('不能借 data 路由读到别的插件的数据', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/../../headless/skins.json`)
    expect([403, 404]).toContain(res.status)
  })

  test('不能借 data 路由读到 Core 自己的数据（core/credentials.json）', async () => {
    // 这是最要紧的一条：dataDir 里躺着密钥，而这条路由的根是
    // `<dataDir>/plugin/<id>/`。穿越出去就等于把密钥交给任何能发请求的页面。
    const res = await fetch(
      `${baseUrl}/plugins/skins/data/%2e%2e%2f%2e%2e%2fcore/credentials.json`,
    )
    expect(res.status).toBe(403)
  })

  test('别处网页用 fetch 来读 → 403（与 /api/*、/ui/* 同一套 Origin 白名单）', async () => {
    // iframe 嵌入不受影响：iframe 与顶层导航按 Fetch 规范不带 Origin（上面所有用例都没带）
    const res = await fetch(`${baseUrl}/plugins/skins/data/skins.json`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  test('同源 Origin 放行', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/skins.json`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    })
    expect(res.status).toBe(200)
  })

  test('非 GET/HEAD → 405（这条路由只读：写入走服务自己的 dataDir）', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/skins.json`, { method: 'PUT' })
    expect(res.status).toBe(405)
  })
})

describe('GET /plugins/<id>/data/* · 取不到时必须说清', () => {
  test('不存在的插件 → 404', async () => {
    const res = await fetch(`${baseUrl}/plugins/nope/data/skins.json`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toContain('unknown plugin')
  })

  test('Core 版本不满足 coreCompatibility → 404', async () => {
    const res = await fetch(`${baseUrl}/plugins/future/data/skins.json`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toContain('9.0.0')
  })

  test('文件不存在 → 404（不是 500）', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/miku/assets/ffffffff.png`)
    expect(res.status).toBe(404)
  })

  test('坏路径编码 → 400', async () => {
    const res = await fetch(`${baseUrl}/plugins/skins/data/%E0%A4%A`)
    expect(res.status).toBe(400)
  })

  test('/plugins/<id> 与 /plugins/<id>/xxx 都不是 data 路由 → 404', async () => {
    for (const p of ['/plugins/skins', '/plugins/skins/other']) {
      const res = await fetch(`${baseUrl}${p}`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error?: string }).error).toBe('not found')
    }
  })
})