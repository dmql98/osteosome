/**
 * mcp-tools（P7 M4 WS-11）—— MCP 全套。
 *
 * ## 「MCP 是动态的」关在这一层里
 *
 * 它把每个 MCP server 连上、`tools/list` 到的那批工具**当成普通工具登记**
 * （`tool.registered`，恒 `risk:'proc'`，`managedBy:'auto'`）。于是 loop / 闸门 / 界面对 MCP
 * 与对 `read` **一视同仁**，差异全在这里。
 *
 * ## 生命周期是它的责任
 *
 * - 删 server / 插件被 kill → **杀子进程**（`McpStdioClient.close`），注销那批工具。
 * - 断一个 server 只影响它那一批（重登记 union；连不上的不进目录）。
 * - 恒 `proc` → **永远逐次审批**（每次 tool.execute 都发 approval.requested，不缓存 remember）。
 *
 * ## 它拥有 `mcp-servers.json`（userData/plugin/tools/）
 */
import { Service, logger } from '@osteosome/service-sdk'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseToolArguments, type MCPServerConfig, type ToolRisk } from '@osteosome/shared'
import { McpStdioClient, type McpTool } from './mcp'

const SERVICE_ID = 'mcp-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

let dataDir = ''
const serversFile = (): string => join(dataDir, 'mcp-servers.json')

/** serverId → { client, tools }（stdio） */
const connected = new Map<string, { client: McpStdioClient; tools: McpTool[] }>()
/** 登记名（`<serverId>__<tool>`）→ { serverId, tool } */
const toolIndex = new Map<string, { serverId: string; tool: string }>()

function atomicWrite(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

function loadServers(): MCPServerConfig[] {
  if (!existsSync(serversFile())) return []
  try {
    const parsed = JSON.parse(readFileSync(serversFile(), 'utf8')) as { servers?: MCPServerConfig[] } | MCPServerConfig[]
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.servers) ? parsed.servers : []
  } catch {
    return []
  }
}

function publishRegistered(): void {
  const tools = []
  for (const [serverId, { tools: mcpTools }] of connected) {
    for (const t of mcpTools) {
      tools.push({
        name: `${serverId}__${t.name}`,
        description: t.description ?? `MCP tool ${t.name} @ ${serverId}`,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        risk: 'proc' as ToolRisk,
        managedBy: 'auto' as const,
      })
    }
  }
  service.publish('tool.registered', { serviceId: SERVICE_ID, tools })
}

async function connect(server: MCPServerConfig): Promise<void> {
  if (server.transport !== 'stdio') {
    logger.warn(`mcp-tools: server '${server.id}' transport '${server.transport}' 暂不支持（仅 stdio）`)
    return
  }
  if (!server.command) {
    logger.warn(`mcp-tools: server '${server.id}' 缺 command`)
    return
  }
  const client = new McpStdioClient(server.command, server.args ?? [], () => {
    // 进程退出 → 注销它那一批（连同从索引里删）
    connected.delete(server.id)
    for (const [name, ref] of [...toolIndex]) if (ref.serverId === server.id) toolIndex.delete(name)
    publishRegistered()
    logger.warn(`mcp-tools: server '${server.id}' 断开，已注销其工具`)
  })
  try {
    await client.initialize()
    const tools = await client.listTools()
    connected.set(server.id, { client, tools })
    for (const t of tools) toolIndex.set(`${server.id}__${t.name}`, { serverId: server.id, tool: t.name })
    logger.info(`mcp-tools: server '${server.id}' connected, ${tools.length} tools`)
  } catch (err) {
    logger.warn(`mcp-tools: server '${server.id}' 连接失败: ${String(err)}`)
    client.close()
  }
}

/** 让连接集合与配置一致：关掉移除/停用的，连上新增/启用的 */
async function reconcile(next: readonly MCPServerConfig[]): Promise<void> {
  const want = new Map(next.filter((s) => s.enabled !== false).map((s) => [s.id, s]))
  for (const [id, { client }] of [...connected]) {
    if (!want.has(id)) {
      client.close()
      connected.delete(id)
      for (const [name, ref] of [...toolIndex]) if (ref.serverId === id) toolIndex.delete(name)
    }
  }
  for (const [id, cfg] of want) {
    if (!connected.has(id)) await connect(cfg)
  }
  publishRegistered()
}

service.subscribe('tools.list', () => publishRegistered())

service.subscribe('tools.mcp.set', (payload) => {
  const servers = Array.isArray(payload.servers) ? (payload.servers as MCPServerConfig[]) : []
  try {
    atomicWrite(serversFile(), `${JSON.stringify({ servers }, null, 2)}\n`)
  } catch (err) {
    logger.warn(`mcp-tools: 保存 mcp-servers.json 失败: ${String(err)}`)
  }
  void reconcile(servers)
})

service.subscribe('tools.mcp.test', (payload) => {
  const serverId = typeof payload.server === 'string' ? payload.server : ''
  const server = loadServers().find((s) => s.id === serverId)
  if (!server) return
  void connect(server).then(() => {
    const c = connected.get(serverId)
    logger.info(`mcp-tools: test '${serverId}' → ${c ? `${c.tools.length} tools` : 'failed'}`)
  })
})

// 逐次审批（proc）：每次工具调用都问一次，不 remember
const pendingApproval = new Map<string, (approved: boolean) => void>()
service.subscribe('tool.approval.resolved', (p) => {
  const id = typeof p.requestId === 'string' ? p.requestId : ''
  const s = id ? pendingApproval.get(id) : undefined
  if (s) {
    pendingApproval.delete(id)
    s(p.approved === true)
  }
})
function askApproval(T: string, sessionId: string, name: string, args: Record<string, unknown>): Promise<boolean> {
  service.publish('tool.approval.requested', { requestId: T, sessionId, toolName: name, risk: 'proc', arguments: JSON.stringify(args), kind: 'exec' })
  return new Promise<boolean>((resolve) => {
    pendingApproval.set(T, resolve)
    setTimeout(() => {
      if (pendingApproval.delete(T)) resolve(false)
    }, 120_000)
  })
}

service.subscribe('tool.execute', async (payload) => {
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!T) return
  const ref = toolIndex.get(name)
  if (!ref) return // 不是 MCP 工具（或该 server 已断）
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const args = parseToolArguments(typeof payload.arguments === 'string' ? payload.arguments : '{}') ?? {}
  if (!(await askApproval(T, sessionId, name, args))) {
    service.publish('tool.execute.result', { requestId: T, ok: false, content: '审批被拒绝或超时', summary: '审批未通过' })
    return
  }
  const entry = connected.get(ref.serverId)
  if (!entry) {
    service.publish('tool.execute.result', { requestId: T, ok: false, content: `MCP server '${ref.serverId}' 已断开`, summary: 'server 断开' })
    return
  }
  try {
    const r = await entry.client.callTool(ref.tool, args)
    service.publish('tool.execute.result', { requestId: T, ok: r.ok, content: r.content, summary: `mcp ${ref.serverId}__${ref.tool}` })
  } catch (err) {
    service.publish('tool.execute.result', { requestId: T, ok: false, content: String((err as Error)?.message ?? err), summary: 'MCP 调用失败' })
  }
})

async function main(): Promise<void> {
  await service.start()
  const dir = service.dataDir || process.env.DS_DATA_DIR
  if (!dir) throw new Error('mcp-tools: no dataDir from the handshake')
  dataDir = dir
  const servers = loadServers()
  logger.info(`mcp-tools: ${servers.length} server(s) configured`)
  await reconcile(servers)
}

main().catch((err: unknown) => {
  console.error(`mcp-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
