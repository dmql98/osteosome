/**
 * web-tools（P7 M4 WS-8）—— webfetch。协议白名单（http/https），5 MB 截断，超时夹到 120s。
 */
import { Service, logger } from '@osteosome/service-sdk'
import { parseToolArguments, validateConstraints, type ConstraintField, type ToolRisk } from '@osteosome/shared'

const SERVICE_ID = 'web-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

const CONSTRAINT_FIELDS: ConstraintField[] = [
  { key: 'allowed_domains', label: '允许域名', type: 'string-list', validateArg: 'url', validateRule: 'glob-allow' },
]
const TOOLS = [
  {
    name: 'webfetch',
    description: '抓取一个 http/https URL 的文本内容（5 MB 截断）',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    risk: 'net' as ToolRisk,
    constraintFields: CONSTRAINT_FIELDS,
  },
]

let constraints: Record<string, Record<string, unknown>> = {}
function registerTools(): void {
  service.publish('tool.registered', { serviceId: SERVICE_ID, tools: TOOLS })
}
service.subscribe('tools.state', (p) => {
  const c = (p as { constraints?: unknown } | null)?.constraints
  if (c && typeof c === 'object') constraints = c as Record<string, Record<string, unknown>>
})
service.subscribe('tools.list', registerTools)

const pending = new Map<string, (ok: boolean) => void>()
service.subscribe('tool.approval.resolved', (p) => {
  const id = typeof p.requestId === 'string' ? p.requestId : ''
  const s = id ? pending.get(id) : undefined
  if (s) {
    pending.delete(id)
    s(p.approved === true)
  }
})
function ask(T: string, sessionId: string, name: string, args: Record<string, unknown>): Promise<boolean> {
  service.publish('tool.approval.requested', { requestId: T, sessionId, toolName: name, risk: 'net', arguments: JSON.stringify(args), kind: 'exec' })
  return new Promise<boolean>((resolve) => {
    pending.set(T, resolve)
    setTimeout(() => {
      if (pending.delete(T)) resolve(false)
    }, 120_000)
  })
}

service.subscribe('tool.execute', async (payload) => {
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (T === '' || name !== 'webfetch') return
  const out = (ok: boolean, content: string, summary = content) => service.publish('tool.execute.result', { requestId: T, ok, content, summary })
  const args = parseToolArguments(typeof payload.arguments === 'string' ? payload.arguments : '{}') ?? {}
  const cviol = validateConstraints(CONSTRAINT_FIELDS, constraints[name] ?? {}, args)
  if (cviol) return out(false, cviol)
  const url = String(args.url ?? '')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return out(false, `非法 URL '${url}'`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return out(false, `协议 ${parsed.protocol} 不允许（仅 http/https）`)
  if (!(await ask(T, typeof payload.sessionId === 'string' ? payload.sessionId : '', name, args))) return out(false, '审批被拒绝或超时')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    const text = (await res.text()).slice(0, 5 * 1024 * 1024)
    out(res.ok, text, `webfetch ${res.status} ${url}`)
  } catch (err) {
    out(false, String((err as Error)?.message ?? err))
  }
})

async function main(): Promise<void> {
  await service.start()
  registerTools()
  logger.info('web-tools: registered webfetch')
}
main().catch((err: unknown) => {
  console.error(`web-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
