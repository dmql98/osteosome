/**
 * POST /api/command（P1a WS-4）—— 202 Accepted → `bus.publish(topic, payload)`。
 * body 形状：`{ topic: string, payload?: object }`；缺 topic / 非法 JSON → 400。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { COMMAND_TOPICS } from '@osteosome/shared'
import type { Bus } from '../bus/bus'
import { readJsonBody, sendJson } from './util'

export interface CommandControl {
  controlService?: (command: 'restart' | 'stop' | 'start', serviceId: string) => Promise<string | null>
  /**
   * 插件启停（S7-2b）。展开成服务启停由 PluginRegistry 做 ——
   * 「一个插件包含哪些服务」是插件层的数据，命令层不该知道。
   */
  controlPlugin?: (
    command: 'start' | 'stop',
    pluginId: string,
  ) => Promise<{ serviceIds: string[] } | string>
}

export async function handleCommand(
  req: IncomingMessage,
  res: ServerResponse,
  bus: Bus,
  controlService?: CommandControl['controlService'],
  controlPlugin?: CommandControl['controlPlugin'],
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
  if (!(COMMAND_TOPICS as readonly string[]).includes(topic)) {
    sendJson(res, 400, { error: `topic '${topic}' is not a command` })
    return
  }
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    sendJson(res, 400, { error: 'payload must be a JSON object' })
    return
  }
  const p = (payload ?? {}) as Record<string, unknown>

  // 服务控制命令由 Core 直接执行（ServiceManager 持有真实进程句柄，服务自身无从管理）。
  if (topic === 'service.restart' || topic === 'service.stop' || topic === 'service.start') {
    const serviceId = typeof p.serviceId === 'string' && p.serviceId.trim() ? p.serviceId : ''
    if (!serviceId) {
      sendJson(res, 400, { error: 'payload.serviceId (string) is required' })
      return
    }
    if (!controlService) {
      sendJson(res, 500, { error: `topic '${topic}' not supported (no control handler)` })
      return
    }
    const command = topic === 'service.restart' ? 'restart' : topic === 'service.stop' ? 'stop' : 'start'
    const err = await controlService(command, serviceId)
    if (err) {
      sendJson(res, 400, { error: `service.${command}: ${err}` })
      return
    }
    sendJson(res, 202, { ok: true, topic })
    return
  }

  // 插件启停由 Core 直接执行：插件不是进程，没有自己的句柄，
  // 必须展开成「停它带的那些服务」（S7-2b）。
  if (topic === 'plugin.start' || topic === 'plugin.stop') {
    const pluginId = typeof p.pluginId === 'string' && p.pluginId.trim() ? p.pluginId : ''
    if (!pluginId) {
      sendJson(res, 400, { error: 'payload.pluginId (string) is required' })
      return
    }
    if (!controlPlugin) {
      sendJson(res, 500, { error: `topic '${topic}' not supported (no plugin layer)` })
      return
    }
    const command = topic === 'plugin.start' ? 'start' : 'stop'
    const result = await controlPlugin(command, pluginId)
    if (typeof result === 'string') {
      sendJson(res, 400, { error: `${topic}: ${result}` })
      return
    }
    sendJson(res, 202, { ok: true, topic, pluginId, services: result.serviceIds })
    return
  }

  // 其余命令直达总线；Bus 负责归一化 ts/source 与 JSON 可序列化校验
  bus.publish(topic, p)
  sendJson(res, 202, { ok: true, topic })
}
