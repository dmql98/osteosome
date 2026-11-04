/**
 * web-tools（P7 M4 WS-8）—— webfetch + websearch。
 *
 * - `webfetch`：抓一个 URL 的文本（协议白名单 http/https，5 MB 截断，超时 120s）；
 * - `websearch`：搜一次网络，回「标题 + URL + 摘要」的纯文本 —— 两个后端，
 *   配了 `OST_SEARCH_ENDPOINT`（SearxNG 之类自建实例）就走它，否则退回 DuckDuckGo lite。
 *   解析与兜底细节见 `search.ts`。
 *
 * 两个都是 `risk:'net'`：默认策略 `ask`，所以会在对话里弹审批。
 * 想让它自走，在工具页把 `websearch` 的策略改成 `auto`（owner = tools 闸门的 `approvals.json`）。
 */
import { Service, logger } from '@osteosome/service-sdk'
import { parseToolArguments, validateConstraints, type ConstraintField, type ToolRisk } from '@osteosome/shared'
import { renderSearch, searchWeb } from './search'

const SERVICE_ID = 'web-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

const DOMAIN_CONSTRAINTS: ConstraintField[] = [
  { key: 'allowed_domains', label: '允许域名', type: 'string-list', validateArg: 'url', validateRule: 'glob-allow' },
]
const TOOLS = [
  {
    name: 'webfetch',
    description: '抓取一个 http/https URL 的文本内容（5 MB 截断）',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    risk: 'net' as ToolRisk,
    constraintFields: DOMAIN_CONSTRAINTS,
  },
  {
    name: 'websearch',
    description: '联网搜索（返回标题 / URL / 摘要）。需要查最新信息、或不知道具体网址时先用它',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number' },
      },
      required: ['query'],
    },
    risk: 'net' as ToolRisk,
  },
]

/** 本执行者负责的工具名（不认识的直接不理，别的执行者会接手） */
const HANDLED = new Set(TOOLS.map((t) => t.name))

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
  if (T === '' || !HANDLED.has(name)) return
  const out = (ok: boolean, content: string, summary = content) => service.publish('tool.execute.result', { requestId: T, ok, content, summary })
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const args = parseToolArguments(typeof payload.arguments === 'string' ? payload.arguments : '{}') ?? {}
  const decl = TOOLS.find((t) => t.name === name)

  const cviol = validateConstraints(decl?.constraintFields ?? [], constraints[name] ?? {}, args)
  if (cviol) return out(false, cviol)

  if (name === 'websearch') {
    const query = String(args.query ?? '')
    if (query.trim() === '') return out(false, 'websearch: query 不能为空')
    if (!(await ask(T, sessionId, name, args))) return out(false, '审批被拒绝或超时')
    try {
      const limit = typeof args.max_results === 'number' && args.max_results > 0 ? Math.floor(args.max_results) : undefined
      const outcome = await searchWeb({
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(process.env.OST_SEARCH_ENDPOINT ? { endpoint: process.env.OST_SEARCH_ENDPOINT } : {}),
      })
      out(true, renderSearch(query, outcome.hits, outcome.backend), `websearch ${query} → ${outcome.hits.length} 条（${outcome.backend}）`)
    } catch (err) {
      out(false, `搜索失败：${String((err as Error)?.message ?? err)}`)
    }
    return
  }

  const url = String(args.url ?? '')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return out(false, `非法 URL '${url}'`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return out(false, `协议 ${parsed.protocol} 不允许（仅 http/https）`)
  if (!(await ask(T, sessionId, name, args))) return out(false, '审批被拒绝或超时')
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
  logger.info(`web-tools: registered ${TOOLS.map((t) => t.name).join(', ')}`)
}
main().catch((err: unknown) => {
  console.error(`web-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
