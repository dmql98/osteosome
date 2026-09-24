/**
 * GET/PUT /api/preferences（P1a WS-4）—— Core 自己的偏好存 dataDir JSON。
 * 路径：`${dataDir}/preferences.json`（不走 serviceDataDir 服务目录约定）。
 * GET 缺省 → `{}`；PUT 必须是 JSON 对象。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ensureDir, preferencesFile } from '../config'
import { readJsonBody, sendJson } from './util'

export async function handlePreferences(
  req: IncomingMessage,
  res: ServerResponse,
  dataDir: string,
): Promise<void> {
  const file = preferencesFile(dataDir)

  if (req.method === 'GET') {
    if (!existsSync(file)) {
      sendJson(res, 200, {})
      return
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      sendJson(res, 200, raw)
    } catch (err) {
      sendJson(res, 500, { error: `preferences file corrupt: ${String(err)}` })
    }
    return
  }

  // PUT
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON body: ${String(err)}` })
    return
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  ensureDir(dataDir)
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  sendJson(res, 200, { ok: true })
}
