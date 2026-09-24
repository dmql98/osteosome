/**
 * 静态资源（P1a WS-4）—— distDir 存在则 serve，否则回 `index.html` 占位。
 * 路径穿越防护：resolve 后必须仍在 distDir 内，否则 403。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'
import { sendJson } from './util'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Osteosome</title></head>
<body>
  <h1>Osteosome Core</h1>
  <p>Client bundle not built yet. Run <code>pnpm build</code> for the UI.</p>
  <p><a href="/health">/health</a></p>
</body>
</html>
`

function sendHtml(res: ServerResponse, status: number, html: string): void {
  if (res.writableEnded || res.destroyed) return
  const buf = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
  })
  res.end(buf)
}

/**
 * 处理 GET 静态请求。pathname 为 URL pathname（以 `/` 开头）。
 * - distDir 缺失 / 文件缺失 → 占位 index.html（200）
 * - 路径穿越 → 403 JSON
 */
export function handleStatic(res: ServerResponse, distDir: string, pathname: string): void {
  // 先 decode 再剥前导分隔符（保持相对），最后 resolve + 前缀校验；
  // 若先 normalize 会把 `/../..` 塌成绝对路径导致穿越检查失效。
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: 'bad path encoding' })
    return
  }
  const rel = decoded.replace(/^[/\\]+/, '')
  const root = resolve(distDir)
  const target = resolve(root, rel)

  // 路径穿越：resolve 后必须仍在 root 之下（含 root 自身）
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, 403, { error: 'forbidden path' })
    return
  }

  try {
    if (existsSync(target) && statSync(target).isFile()) {
      const data = readFileSync(target)
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length })
      res.end(data)
      return
    }
    // SPA fallback：根路径或未知路径给占位/已有 index.html
    const indexFile = join(root, 'index.html')
    if (existsSync(indexFile)) {
      const data = readFileSync(indexFile)
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': data.length })
      res.end(data)
      return
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err) })
    return
  }

  sendHtml(res, 200, PLACEHOLDER_HTML)
}
