/**
 * GET/PUT `/api/config` —— 引导配置（`<应用根>/ost.config.json`）。
 *
 * 这是**唯一能改数据目录的入口**：`preferences.json` 住在数据目录里，
 * 而这个文件决定的正是数据目录在哪，所以它必须待在数据目录之外。
 *
 * - `GET`  → `{ dataDir?, configFilePath }`（没配过就是没有 `dataDir` 字段）
 * - `PUT`  → body `{ dataDir: string | null }`
 *   - 字符串：写进去；相对路径按**配置文件所在的应用根**解析（与 `loadConfig` 读它时同一个基准）
 *   - `null` / 省略：删掉这一项 → 恢复缺省
 *   - 成功一律 `restartRequired: true` —— dataDir 在 Core 启动时定死，运行中改不动
 *
 * 为什么不做热切换：服务子进程、凭证库、偏好句柄全都拿着启动时那份 dataDir，
 * 运行中换根等于让这些句柄指向两个地方；而 Core 本身是被外部（`start-client.cmd`）
 * 拉起的，也没有一条「重启自己」的通道。所以诚实地告诉用户：重启后生效。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ensureDir, readBootConfig, writeBootConfig } from '../config'
import { readJsonBody, sendJson } from './util'

/** dataDir 长度上限 —— 它是个路径，超了只可能是把别的东西塞进了 body */
const MAX_DATA_DIR_LENGTH = 4096

export async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse,
  configFilePath: string | undefined,
): Promise<void> {
  // 手写的测试配置（core/tests 里的 CoreConfig 字面量）不带这个字段 ——
  // 与其猜一个路径去写，不如明确说做不了
  if (configFilePath === undefined) {
    sendJson(res, 404, { error: 'boot config path unknown' })
    return
  }

  if (req.method === 'GET') {
    sendJson(res, 200, { ...readBootConfig(configFilePath), configFilePath })
    return
  }

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

  const raw = (body as { dataDir?: unknown }).dataDir
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    sendJson(res, 400, { error: 'dataDir must be a string or null' })
    return
  }

  // 恢复缺省：删掉引导配置里的这一项（写回时 undefined 会被丢掉）
  if (raw === null || raw === undefined) {
    writeBootConfig(configFilePath, { dataDir: undefined })
    sendJson(res, 200, { ok: true, dataDir: null, restartRequired: true })
    return
  }

  const value = raw.trim()
  if (value === '' || value.length > MAX_DATA_DIR_LENGTH) {
    sendJson(res, 400, { error: `dataDir must be 1-${MAX_DATA_DIR_LENGTH} characters` })
    return
  }

  // 相对路径按配置文件所在的应用根解析 —— 与 loadConfig 读它时同一个基准
  const target = isAbsolute(value) ? value : resolve(dirname(configFilePath), value)
  // 现在就建一次：路径打错了要在这里报错，而不是等下次启动时才发现数据目录起不来
  try {
    ensureDir(target)
  } catch (err) {
    sendJson(res, 500, { error: `cannot create data directory: ${String(err)}` })
    return
  }

  writeBootConfig(configFilePath, { dataDir: target })
  sendJson(res, 200, { ok: true, dataDir: target, restartRequired: true })
}
