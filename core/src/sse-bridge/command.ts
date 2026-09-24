/**
 * POST /api/command（P1a WS-4）—— 202 Accepted → `bus.publish(topic, payload)`。
 * body 形状：`{ topic: string, payload?: object }`；缺 topic / 非法 JSON → 400。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Bus } from '../bus/bus'
import { readJsonBody, sendJson } from './util'

export async function handleCommand(
  req: IncomingMessage,
  res: ServerResponse,
  bus: Bus,
): Promise<void> {
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
  const { topic, payload } = body as { topic?: unknown; payload?: unknown }
  if (typeof topic !== 'string' || topic.trim() === '') {
    sendJson(res, 400, { error: 'topic (string) is required' })
    return
  }
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    sendJson(res, 400, { error: 'payload must be a JSON object' })
    return
  }

  // 命令直达总线；Bus 负责归一化 ts/source 与 JSON 可序列化校验
  bus.publish(topic, (payload ?? {}) as Record<string, unknown>)
  sendJson(res, 202, { ok: true, topic })
}
