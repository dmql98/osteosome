/**
 * `GET /plugins/<id>/ui/<path>` —— 伺服插件的 WebUI 产物（P3）
 *
 * ## 同源，而不是再开一个端口
 *
 * 每个插件 UI 都是普通静态站点，为什么不由插件自己起一个端口？
 * · **同源才有同源存储**。前端 `postMessage` + `parent.localStorage` + `BroadcastChannel`
 *   这一整套「窗口间通信」全都只在同源下成立（跨源要 postMessage 握手 + 配对 token，
 *   见 P5 AOCI 那条「不可互信」）。同源把这些复杂度整块消掉。
 * · **不必逐个开端口/记端口/做端口分配与回收**（Core 已经占 4317，还要端口池与冲突重试）。
 * · **一个 Origin 白名单就够**（沿用 `static.ts` 那套：无 Origin / `null` / 127.0.0.1 / localhost）。
 *   插件多起一个源，就多一处 CSRF 面。
 *
 * 代价是「插件 UI 与宿主 UI 共享一个端口」——这正是想要的：工作台最终就是同一个页面。
 *
 * ## 命名空间是必需的，不是洁癖
 *
 * 路由带 `/plugins/<id>/ui/` 前缀，于是**插件的 Vite `base` 必须设成同一个前缀**。
 * 否则默认 `base: '/'` 会让所有插件的 chunk 抢同一个全局 `/assets/index-xxx.js` ——
 * 症状是两个插件互相「换脸」（A 的页面加载到 B 的 JS），且只在同时装两个插件时出现。
 * Core 修不了这个（它不参与打包），所以在 `plugin.json` 的 `ui.views[].entry`
 * 与 P5 的构建脚本里都要写死这个约定。
 *
 * ## hash 切视图 = Core 不需要知道任何路由
 *
 * `index.html#timeline` 的 `#` 后半段**根本不会发到服务器**。所以 Core 只当静态文件
 * 搬运工：没有路由表、没有重写规则、没有「这个路径该回哪个视图」的判断。
 * 深链与刷新能不能工作，全由插件自己的 hash 状态决定。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginRegistry } from '../service-manager/plugin-registry-runtime'
import { contentTypeFor, methodNotAllowed, sendJson } from './util'

/** 路由前缀：`/plugins/<id>/ui/...` */
const PREFIX = '/plugins/'

export function handlePluginUi(
  req: IncomingMessage,
  res: ServerResponse,
  registry: PluginRegistry | undefined,
  pathname: string,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }
  if (!registry) {
    sendJson(res, 404, { error: 'plugin layer not enabled' })
    return
  }

  // 与 static.ts 同一套「先 decode 再剥前导分隔符」的顺序：先 normalize 会把
  // `/../..` 塌成绝对路径，穿越检查就失效了。
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: 'bad path encoding' })
    return
  }
  if (!decoded.startsWith(PREFIX)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const rest = decoded.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  // `/plugins/<id>` 或 `/plugins/<id>/xxx` 都不是 UI 路由 —— 让 static.ts 去接
  if (slash < 0) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const pluginId = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  if (tail !== 'ui' && !tail.startsWith('ui/')) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  // `/plugins/<id>/ui` 后面接的是路径部分
  const rel = tail.slice('ui'.length).replace(/^[/\\]+/, '')

  const lookup = registry.uiDir(pluginId)
  if (!lookup.ok) {
    // 全部 404（理由见 PluginRegistry.uiDir 的注释）：停用/未构建不该留下可见的错误页
    sendJson(res, 404, { error: lookup.error })
    return
  }

  const root = resolve(lookup.dir)
  // 空路径或以 `/` 结尾 = 目录视图 → index.html。
  // 这样 `/plugins/x/ui` 与 `/plugins/x/ui/` 等价，前端不用关心有没有那个尾斜杠。
  const target = resolve(root, rel === '' || rel.endsWith('/') ? 'index.html' : rel)

  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, 403, { error: 'forbidden path' })
    return
  }

  try {
    if (existsSync(target) && statSync(target).isFile()) {
      const data = readFileSync(target)
      res.writeHead(200, {
        'Content-Type': contentTypeFor(target),
        'Content-Length': data.length,
        // 插件产物带内容哈希，但 index.html 不带；`no-cache` 让 index.html 永远回源
        // （否则插件升级后用户被旧 index.html 指着已删除的 chunk → 白屏），
        // 而带哈希的 assets 每次都会命中缓存，省掉重复下载。
        //
        // 哈希字母表必须与打包器一致：Vite 默认用 base64url，**含 `-` 与 `_`**
        // （`index-C3j-Xspt.js` 就是真的）。只认 `[0-9a-zA-Z]` 的话，
        // 大约每五次构建就有一次哈希里带这两个字符，assets 静悄悄退回 no-cache ——
        // 功能上没坏，只是每次都重下，而断言 immutable 的用例会随机变红。
        'Cache-Control': /-[0-9a-zA-Z_-]{6,}\.[a-z0-9]+$/.test(target)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(data)
      return
    }
    // SPA fallback：未知路径回到 index.html（hash 路由下几乎不会走到，
    // 但「多一个 / 」就白屏是很糟的体验）。dist/ui 没有 index.html → 真 404。
    const indexFile = join(root, 'index.html')
    if (existsSync(indexFile)) {
      const data = readFileSync(indexFile)
      res.writeHead(200, {
        'Content-Type': contentTypeFor(indexFile),
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(data)
      return
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err) })
    return
  }

  sendJson(res, 404, { error: 'ui entry not found' })
}