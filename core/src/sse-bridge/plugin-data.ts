/**
 * `GET /plugins/<id>/data/<path>` —— 伺服插件的**用户数据**（S7 之后）
 *
 * ## 为什么这条路由存在
 *
 * 插件的用户数据落在 `<dataDir>/plugin/<id>/`（`shared/src/paths.ts` 的 `pluginDataDir`），
 * 而握手时 Core 已经把这个目录发给服务了 —— **写入不需要 Core 参与**。
 * 但**读**需要：浏览器要拿立绘、头像、动画帧，只有 Core 有 HTTP 面。
 *
 * 一条不存在的路由会逼出三种绕过方式，每一种都比这条路由糟：
 * · 资产塞进 `dist/ui`（构建产物）→ 用户上传的东西在构建期还不存在
 * · 插件自己起端口 → 与 `plugin-ui.ts` 开头那段「同源」论证相反，多一处 CSRF 面
 * · 走总线 base64 → 撞 2 MiB 与帧大小
 *
 * 所以这是**一条只读路由**，Core 的职责仍然是两句：查白名单、搬字节。
 * 它不知道什么是 portrait，也不需要知道 userData 里哪个目录归哪个插件
 * （`registry.dataDir()` 给了现成答案）。
 *
 * ## 与 `/plugins/<id>/ui/*` 同构，但有一处**故意不同**
 *
 * 同构：同一段路径切分、同一套穿越检查、同一份 MIME 与缓存头判据。
 * 不复用代码是因为两份要独立演化（`/data/` 的客户端在插件里，`/ui/` 的在 Core 里）。
 *
 * 故意不同的**只有 SPA fallback**：
 *
 * · `/ui/*` 伺服**页面**，未知路径回 `index.html` 是对的（hash 路由下几乎走不到，
 *   但「多一个 / 」就白屏是很糟的体验）
 * · `/data/*` 伺服**数据**，回 `index.html` 会让「资产不存在」变成一段 HTML ——
 *   而 `<img src>` 拿到 200 + text/html 会走 `onerror`，
 *   症状是「图片加载失败」，而真实原因是「路径拼错了」。
 *   **404 让这两个可区分**，所以这里必须真 404。
 *
 * 代价要记着：`SkinRenderer` 的回退链仍要靠 `onerror`，
 * 但它现在只需要区分「文件不在」这一种情况，而不是同时对付 404 与 HTML。
 *
 * ## 为什么过 Origin 白名单（与 `/ui/*` 同一套判定，在 `server.ts` 里）
 *
 * 它伺服的是**用户的数据**，比 UI 更敏感。不加白名单等于开一个能读
 * `<dataDir>/plugin/*` 的跨源口子 —— 而 `dataDir` 里有密钥。
 * iframe 嵌入不受影响：iframe 与顶层导航按 Fetch 规范不带 Origin，
 * 白名单本来就放行「无 Origin」。
 *
 * ## 为什么不支持写入
 *
 * 服务握手里就有可写的 `dataDir`，它自己 fs 写就行，然后重播 `*.state`。
 * 给 Core 加 PUT/DELETE 要引入 multipart、临时文件、原子落盘、大小限制，
 * **一层都不需要**（§15 第 1 条）。所以这条路由只读。
 */
import { createReadStream, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginRegistry } from '../service-manager/plugin-registry-runtime'
import { contentTypeFor, methodNotAllowed, sendJson } from './util'

/** 路由前缀：`/plugins/<id>/data/...` */
const PREFIX = '/plugins/'

/** 与 `plugin-ui.ts` 同一套判据（哈希字母表必须与打包器一致，含 `-` 与 `_`） */
const HASHED = /-[0-9a-zA-Z_-]{6,}\.[a-z0-9]+$/

export function handlePluginData(
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

  // 与 static.ts / plugin-ui.ts 同一套「先 decode 再剥前导分隔符」的顺序：
  // 先 normalize 会把 `/../..` 塌成绝对路径，穿越检查就失效了。
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: 'bad path encoding' })
    return
  }
  // Windows：`%2e%2e%5c…` 之类 decode 出反斜杠。剥分隔符时两种都算，
  // 否则 `..\..\core\credentials.json` 会绕过只认 `/` 的检查。
  if (decoded.indexOf('\\') >= 0) decoded = decoded.replace(/\\/g, '/')
  if (!decoded.startsWith(PREFIX)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const rest = decoded.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  // `/plugins/<id>` 或 `/plugins/<id>/xxx` 都不是 data 路由 —— 让 ui / static 去接
  if (slash < 0) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const pluginId = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  if (tail !== 'data' && !tail.startsWith('data/')) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const rel = tail.slice('data'.length).replace(/^\/+/, '')

  // `/plugins/<id>/data` 与 `/plugins/<id>/data/` 都**不是**「目录视图」。
  // 与 `/ui/*` 相反：那里补 index.html 是为了体验，这里补了就是「凭空多一个文件」。
  if (rel === '') {
    sendJson(res, 404, { error: 'data entry not specified' })
    return
  }

  const lookup = registry.dataDir(pluginId)
  if (!lookup.ok) {
    sendJson(res, 404, { error: lookup.error })
    return
  }

  // `pluginDataDir` 带结尾分隔符，`resolve` 会去掉它 —— 所以这里自己补回
  const root = resolve(lookup.dir)
  const target = resolve(root, rel)

  // 两道：`startsWith(root + sep)` 挡住 `../`；`isAbsolute` 挡掉 Windows 上
  // `resolve` 判定为绝对路径的输入（如 `C:/…`、`\\server\share`）。
  if (isAbsolute(rel) || !target.startsWith(root + sep)) {
    sendJson(res, 403, { error: 'forbidden path' })
    return
  }

  try {
    const st = statSync(target)
    // 目录（含符号链接指过去的）不是文件。落到 404 而不是 403：
    // 「这里没有文件」与「没这条路由」对浏览器没有区别，而 403 会让 `<img>`
    // 拿到一段 JSON 而不是解码失败 —— 那更难诊断。
    if (!st.isFile()) {
      sendJson(res, 404, { error: 'not a file' })
      return
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(target),
      'Content-Length': st.size,
      // 插件自己决定文件名。约定是内容寻址（换一张图 = 新 assetId = 新 URL），
      // 命中 immutable 判据就长缓存；没命中就 no-cache —— **不猜**，
      // 因为猜错的症状是「用户换了图、界面还是旧的」，且没有任何报错。
      'Cache-Control': HASHED.test(target) ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target).pipe(res)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
      // 没有 SPA fallback：这里是真 404（理由见文件头）
      sendJson(res, 404, { error: 'data file not found' })
      return
    }
    sendJson(res, 500, { error: String(err) })
    return
  }
}