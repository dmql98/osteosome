import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * 端到端：Core 伺服插件 UI 的产物（P5 链路的核心断言）。
 *
 * ## 为什么必须是「真 Core + 真产物」
 *
 * 这条链路横跨三段，每一段单独都能测，合起来才成立：
 * ① `plugins/models/catalog.json` → 构建时复制进 `dist/ui/`；
 * ② Core 的 `GET /plugins/<id>/ui/*` 伺服 `dist/ui/`；
 * ③ 那个页面 `fetch('catalog.json')` 拿到 12 家预设。
 *
 * 任一段单独测都可能是「绿的但拼不起来」：
 * - 只测构建 → 产物里没有 catalog.json（P5 之前正是这样：UI 根本不 fetch 它）；
 * - 只测路由 → 用手写的临时 index.html，等于没测构建；
 * - 只测 UI 单测 → fetch 是 mock 的，于是「Core 到底伺服不伺服那份文件」没人验。
 *
 * 所以这里三者一起验：跑一次真实构建 → 起真实 Core → 真 HTTP 请求。
 *
 * ## 为什么测的是「拿到 12 家」而不是「页面渲染出来」
 *
 * jsdom 装不了真实浏览器（要 Playwright），而 iframe 里的 Vue 渲染更没必要重测一遍
 * （那份由 plugins/models/ui 自己的 16 条用例守着）。这里要证明的是
 * **Core 伺服的那份文件里真的有 12 家预设** —— 那正是「服务端与 UI 读同一份数据」
 * 在部署形态下的落点。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..')
const UI_PKGS = [join(REPO_ROOT, 'plugins', 'models', 'ui'), join(REPO_ROOT, 'plugins', 'workbench', 'ui')]

let core: import('node:child_process').ChildProcess
let baseUrl: string
let workDir: string
const logs: string[] = []

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', rejectPromise)
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} exited ${String(code)}:\n${out}`)),
    )
  })
}

beforeAll(async () => {
  // ① 真实构建一次（不是复用可能过期的 dist —— 那正是「产物没跟着代码走」的盲区）
  for (const pkg of UI_PKGS) await run('pnpm', ['run', 'build'], pkg)

  // ② 起真实 Core，数据目录指向临时目录（不碰用户真实数据）
  workDir = mkdtempSync(join(tmpdir(), 'ost-ui-e2e-'))
  core = spawn('node', [join(REPO_ROOT, 'core', 'dist', 'main.js'), '--plugins', join(REPO_ROOT, 'plugins'), '--data', workDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, OSTEOSOME_PORT: '0' },
  })
  let buffer = ''
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`core did not start:\n${logs.join('')}`)), 30000)
    core.stdout?.on('data', (d: Buffer) => {
      const text = d.toString()
      buffer += text
      logs.push(text)
      const match = /listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolvePromise(Number(match[2]))
      }
    })
    core.on('error', rejectPromise)
  })
  baseUrl = `http://127.0.0.1:${port}`
}, 120000)

afterAll(() => {
  core?.kill()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('GET /plugins/models/ui/*（真实 Core + 真实产物）', () => {
  test('index.html 可取，且引用的是命名空间下的 assets', async () => {
    const res = await fetch(`${baseUrl}/plugins/models/ui/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    // base 必须是 /plugins/models/ui/ —— 默认的 '/' 会让两个插件抢同一个 /assets/xxx.js
    expect(html).toContain('/plugins/models/ui/assets/')
    expect(html).not.toMatch(/src="\/assets\//)
  })

  test('catalog.json 由 Core 伺服，且含 12 家预设（UI 与服务端读同一份）', async () => {
    const res = await fetch(`${baseUrl}/plugins/models/ui/catalog.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { vendors?: Array<{ id: string }> }
    // 这条是整条链路的落点：UI 在浏览器里拿到的就是这份文件，
    // 服务端经 plugins.readFile 拿的也是 plugins/models/catalog.json —— 同一份被编写的文件
    expect(body.vendors).toHaveLength(12)
    expect(body.vendors?.map((v) => v.id)).toContain('deepseek')
  })

  test('/api/plugins 的快照带 ui.views，且 id 与 Core 伺服路径对得上', async () => {
    const res = await fetch(`${baseUrl}/api/plugins`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      plugins: Array<{ manifest: { id: string; ui?: { views: Array<{ id: string; entry: string }> } } }>
    }
    const models = body.plugins.find((p) => p.manifest.id === 'models')
    expect(models?.manifest.ui?.views.map((v) => v.id)).toEqual(['widget.llm-settings'])
    // entry 拼出来的 URL 必须真的能取到 —— 清单与路由对不上的症状是「界面一片空白」
    const entry = models!.manifest.ui!.views[0]!.entry
    expect((await fetch(`${baseUrl}/plugins/models/ui/${entry}`)).status).toBe(200)
  })

  test('asset 走 immutable 缓存，index.html 走 no-cache', async () => {
    const html = await (await fetch(`${baseUrl}/plugins/models/ui/`)).text()
    const asset = /\/plugins\/models\/ui\/assets\/[^"']+\.js/.exec(html)?.[0]
    expect(asset, 'index.html 里没找到带哈希的 asset').toBeTruthy()
    const assetRes = await fetch(`${baseUrl}${asset}`)
    expect(assetRes.status).toBe(200)
    expect(assetRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await fetch(`${baseUrl}/plugins/models/ui/`)).headers.get('cache-control')).toBe('no-cache')
  })
})

/**
 * P6 新增：两个插件 UI **同时**存在。
 *
 * ## 为什么 P5 的版本不够
 *
 * 仓库里只有一个带 UI 的插件时，命名空间写错也看不出问题 ——
 * `/assets/index-xxx.js` 全局唯一，A 插件和 B 插件会请求到同一份文件，
 * 而「那份文件恰好就是自己要的那个」，于是测试照绿。
 *
 * P6 搬完 workbench 就有两个了。这组断言直接比对两边的 index.html：
 * 各自只引用自己命名空间下的 asset，且**互相不引用**。
 * 这是「base 必须命名空间化」这条纪律唯一的实际验证点 ——
 * 写错了，两个界面会加载对方的代码，而症状是「界面显示成另一个插件的样子」。
 */
describe('两个插件 UI 同时存在（真实 Core + 真实产物）', () => {
  test('workbench 的 index.html 引用自己的命名空间', async () => {
    const res = await fetch(`${baseUrl}/plugins/workbench/ui/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/plugins/workbench/ui/assets/')
    expect(html).not.toMatch(/src="\/assets\//)
  })

  test('两个插件的 asset 路径不重叠', async () => {
    const [modelsHtml, workbenchHtml] = await Promise.all([
      fetch(`${baseUrl}/plugins/models/ui/`).then((r) => r.text()),
      fetch(`${baseUrl}/plugins/workbench/ui/`).then((r) => r.text()),
    ])
    const assetsOf = (html: string) => [...html.matchAll(/\/plugins\/(\w+)\/ui\/assets\/[^"']+/g)].map((m) => m[0])
    const modelsAssets = assetsOf(modelsHtml)
    const workbenchAssets = assetsOf(workbenchHtml)
    expect(modelsAssets.length).toBeGreaterThan(0)
    expect(workbenchAssets.length).toBeGreaterThan(0)
    // 若 base 写错成全局 /assets/，两个插件会指向同一个文件 —— 那就是「A 的界面加载 B 的代码」
    expect(modelsAssets.some((a) => workbenchAssets.includes(a)), '两个插件共用了同一个 asset').toBe(false)
    for (const asset of modelsAssets) expect(asset).toMatch(/^\/plugins\/models\/ui\//)
    for (const asset of workbenchAssets) expect(asset).toMatch(/^\/plugins\/workbench\/ui\//)
  })

  test('/api/plugins 里两个插件的 ui.views 互不重叠', async () => {
    const body = (await (await fetch(`${baseUrl}/api/plugins`)).json()) as {
      plugins: Array<{
        manifest: {
          id: string
          components?: string[]
          ui?: { views: Array<{ id: string; entry: string }> }
        }
      }>
    }
    const workbench = body.plugins.find((p) => p.manifest.id === 'workbench')
    const ids = workbench?.manifest.ui?.views.map((v) => v.id) ?? []
    expect(ids).toEqual([
      'widget.system-info',
      'widget.command-palette',
      'widget.settings',
      'widget.event-stream',
      'widget.service-manager',
      'widget.service-status',
    ])
    // 六个都搬走了，所以 components[] 必须为空 —— 两处同时声明同一个 id
    // 会让客户端不知道该用本地实现还是 iframe，而两者都能渲染出东西
    expect(workbench?.manifest.components ?? []).toEqual([])
  })

  test('workbench 的每个 view entry 拼出的 URL 都真的能取到', async () => {
    const body = (await (await fetch(`${baseUrl}/api/plugins`)).json()) as {
      plugins: Array<{ manifest: { id: string; ui?: { views: Array<{ id: string; entry: string }> } } }>
    }
    const views = body.plugins.find((p) => p.manifest.id === 'workbench')?.manifest.ui?.views ?? []
    expect(views.length).toBeGreaterThan(0)
    for (const view of views) {
      // entry 形如 index.html#system-info —— fragment 不参与 HTTP，请求的是同一个 index.html
      const [pathname] = view.entry.split('#')
      const res = await fetch(`${baseUrl}/plugins/workbench/ui/${pathname}`)
      expect(res.status, `${view.id} 的入口取不到：${view.entry}`).toBe(200)
    }
  })

  test('共享 UI 包没有被打进两个 bundle 各自一份源码副本之外的东西', async () => {
    /**
     * 这条断言测的是**产物形状**：两个 bundle 的 CSS 都含 tokens 的变量定义。
     *
     * 它们本来就该各有一份（iframe 互不共享样式表），而 CSS 变量的**值**
     * 由 core/tests/tokens-parity.test.ts 对账 —— 那条守「值不漂」。
     * 这里守的是「变量名还在」，即 `sdk/ui/src/tokens.css` 真的被两个构建各引一次。
     */
    const [modelsCss, workbenchCss] = await Promise.all(
      ['models', 'workbench'].map(async (id) => {
        const html = await (await fetch(`${baseUrl}/plugins/${id}/ui/`)).text()
        const href = /\/plugins\/\w+\/ui\/assets\/[^"']+\.css/.exec(html)?.[0]
        expect(href, `${id} 的 index.html 里没找到 css`).toBeTruthy()
        return (await fetch(`${baseUrl}${href}`)).text()
      }),
    )
    // 挑一个两种主题下都定义的变量名，避免「这个变量恰好只在 light 里」
    for (const css of [modelsCss, workbenchCss]) {
      expect(css).toContain('--color-bg')
    }
  })
})