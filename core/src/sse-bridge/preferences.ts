/**
 * GET/PUT /api/preferences（P1a WS-4）—— Core 自己的偏好存 dataDir JSON。
 * 路径：${dataDir}/preferences.json`（不走 serviceDataDir 服务目录约定，Core 侧特权文件）。
 * GET 省略 → `{}`；损坏 → 500（让人看见）；PUT 必须是 JSON 对象。
 *
 * 读写实现见 `../preferences.ts`（与子服务 RPC `preferences.get` 共用）。
 */
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { preferencesFile } from '../config'
import { readPreferences, writePreferences } from '../preferences'
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
    const { value, corrupted } = readPreferences(dataDir)
    if (corrupted) {
      // 静默回 {} 等于假装偏好还在 —— 明确报出来
      sendJson(res, 500, { error: `preferences file corrupt: ${file}` })
      return
    }
    sendJson(res, 200, value)
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
  writePreferences(dataDir, body as Record<string, unknown>)
  sendJson(res, 200, { ok: true })
}
