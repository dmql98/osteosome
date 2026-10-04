/**
 * SseBridge HTTP 小工具（P1a WS-4）—— JSON 读写与请求体解析。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'

/** 请求体默认上限（防超大 body 撑爆内存） */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** 读完整请求体为 utf8 文本；超限 → throw */
export function readBody(req: IncomingMessage, limit = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 读并 JSON.parse 请求体；空体 / 非法 JSON → throw */
export async function readJsonBody(req: IncomingMessage, limit?: number): Promise<unknown> {
  const text = await readBody(req, limit)
  if (text.trim() === '') throw new Error('empty request body')
  return JSON.parse(text)
}

/** 以 JSON 应答并结束响应 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 405 + Allow 头（JSON 体） */
export function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.writableEnded || res.destroyed) return
  res.setHeader('Allow', allow)
  sendJson(res, 405, { error: 'method not allowed' })
}

/**
 * 静态资源的 Content-Type 表。
 *
 * 放这里而不是各路由模块里，是因为「伺服静态文件」这件事现在有两个主人
 * （Core 自己的 distClientDir 与插件的 dist/ui），两份 MIME 表意味着迟早有一份漏项 ——
 * 而漏项的症状是「本地能显示、装到别的机器上白屏」。
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

/** 按扩展名给 Content-Type；未知扩展名 → octet-stream（不猜，宁可让浏览器下载） */
export function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}
