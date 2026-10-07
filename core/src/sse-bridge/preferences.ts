/**
 * GET/PUT /api/preferences —— Core 自己的偏好（布局 / 主题 / 插件启停）。
 * 路径：`${dataDir}/core/preferences.json`。
 * GET 省略 → `{}`；损坏 → 500（让人看见）；PUT 必须是 JSON 对象。
 *
 * ## 这里**只**装 Core 自己的键
 *
 * 模型接入清单与密钥曾经也塞在这份文件里（`llm` 段 + 旁边的 `credentials.json`）。
 * 它们归使用方插件之后（`userData/plugin/models/`），本端点对 `llm` 段的态度是
 * **丢掉并说明为什么**：
 * - 静默保存 = 两处真相各自漂移，而用户看到的现象是「改了没生效 / 生效了又没了」；
 * - 报 400 = 一个仍然发着旧请求的老客户端会把整个设置页卡死。
 *
 * 丢掉 + 回一句迁移说明，是三种里唯一不制造第二个真相、也不拦住用户的选择。
 *
 * 读写实现见 `../preferences.ts`（与子服务 RPC `preferences.get` 共用）。
 */
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { preferencesFile } from '../config'
import { readPreferences, writePreferences } from '../preferences'
import { readJsonBody, sendJson } from './util'

/** 曾经住在这里、如今归 models 插件的键 */
const REHOMED_KEYS = ['llm'] as const

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
  const next = { ...(body as Record<string, unknown>) }
  const dropped = REHOMED_KEYS.filter((key) => key in next)
  for (const key of dropped) delete next[key]
  writePreferences(dataDir, next)
  sendJson(res, 200, {
    ok: true,
    ...(dropped.length > 0
      ? {
          ignoredKeys: dropped,
          reason: `这些键归使用它们的插件自己管了（models 接入清单在 userData/plugin/models/preferences.json）。`,
        }
      : {}),
  })
}
