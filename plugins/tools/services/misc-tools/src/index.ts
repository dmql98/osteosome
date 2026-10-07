/** misc-tools（P7 M4 WS-9）—— 两个只读工具：get_time / debug_sessions */
import { Service, logger } from '@osteosome/service-sdk'
import { parseToolArguments, type ToolRisk } from '@osteosome/shared'

const SERVICE_ID = 'misc-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

const TOOLS = [
  { name: 'get_time', description: '返回当前本地时间（ISO 8601）', parameters: { type: 'object', properties: {} }, risk: 'read' as ToolRisk },
  {
    name: 'debug_sessions',
    description: '返回当前会话的调试信息（只读）',
    parameters: { type: 'object', properties: {} },
    risk: 'read' as ToolRisk,
  },
]

function registerTools(): void {
  service.publish('tool.registered', { serviceId: SERVICE_ID, tools: TOOLS })
}
service.subscribe('tools.list', registerTools)

service.subscribe('tool.execute', (payload) => {
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!T || (name !== 'get_time' && name !== 'debug_sessions')) return
  const out = (ok: boolean, content: string, summary = content) => service.publish('tool.execute.result', { requestId: T, ok, content, summary })
  void parseToolArguments(typeof payload.arguments === 'string' ? payload.arguments : '{}')
  if (name === 'get_time') return out(true, new Date().toISOString(), 'get_time')
  out(true, JSON.stringify({ sessionId: payload.sessionId ?? '', at: Date.now() }), 'debug_sessions')
})

async function main(): Promise<void> {
  await service.start()
  registerTools()
  logger.info('misc-tools: registered get_time, debug_sessions')
}
main().catch((err: unknown) => {
  console.error(`misc-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
