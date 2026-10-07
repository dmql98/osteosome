/**
 * tools 闸门（P7 M2 WS-4）—— **只答「允许吗」，不认识工具**。
 *
 * ## 它做什么
 *
 * 订阅各执行者的 `tool.registered` 汇成工具目录；订阅 `tool.approval.requested`，
 * 按 risk 默认 / `approvals.json` 的策略应答 `tool.approval.resolved`：
 * - `auto` → 立即批准；`deny` → 立即拒绝；`ask` → **不答**（等用户发 `tool.approval.resolved`）。
 * - `kind:'workspace'` 的审批**忽略**（那由 loop 应答 —— 只有执行者知道自己算出来的沙箱根）。
 *
 * ## 它是 approvals.json / constraints.json 的 owner
 *
 * 机器级审批策略与约束默认值在这里；经 `tools.state` 重播给前端与各执行者
 * （执行者用 `constraints` 在动手前校验）。同名工具**后者拒绝注册、不覆盖**，界面标 ⚠。
 */
import { Service, logger } from '@osteosome/service-sdk'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ApprovalPolicy, ConstraintField, MCPServerConfig, ToolRecord, ToolRisk, ToolSpec } from '@osteosome/shared'

const service = new Service({ id: 'tools', version: '1.0.0' })

interface RegisteredTool extends ToolSpec {
  risk: ToolRisk
  managedBy?: 'user' | 'auto'
  constraintFields?: ConstraintField[]
}

interface GateState {
  /** name → 策略（用户设的；缺省按 risk） */
  policies: Record<string, ApprovalPolicy>
  /** name → 约束值（机器默认） */
  constraints: Record<string, Record<string, unknown>>
  mcpServers: MCPServerConfig[]
}
let state: GateState = { policies: {}, constraints: {}, mcpServers: [] }
let dataDir = ''

/** 执行者登记的目录：serviceId → tools */
const registered = new Map<string, RegisteredTool[]>()

const RISK_DEFAULT: Record<ToolRisk, ApprovalPolicy> = { read: 'auto', write: 'ask', net: 'ask', proc: 'ask' }

function fileFor(name: string): string {
  return join(dataDir, name)
}
function loadJson<T>(name: string, fallback: T): T {
  const f = fileFor(name)
  if (!existsSync(f)) return fallback
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T
  } catch {
    return fallback
  }
}
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
function persist(): void {
  atomicWrite(fileFor('approvals.json'), `${JSON.stringify({ policies: state.policies }, null, 2)}\n`)
  atomicWrite(fileFor('constraints.json'), `${JSON.stringify(state.constraints, null, 2)}\n`)
  atomicWrite(fileFor('mcp-servers.json'), `${JSON.stringify({ servers: state.mcpServers }, null, 2)}\n`)
}

/** 目录（含同名冲突：后者拒绝、标 conflict） */
function catalog(): ToolRecord[] {
  const byName = new Map<string, ToolRecord>()
  for (const [serviceId, tools] of registered) {
    for (const t of tools) {
      const record: ToolRecord = {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        serviceId,
        risk: t.risk,
        enabled: true,
        ...(t.managedBy ? { managedBy: t.managedBy } : {}),
        ...(t.constraintFields
          ? { constraintFields: t.constraintFields, constraintKeys: t.constraintFields.map((f) => f.key) }
          : {}),
      }
      const existing = byName.get(t.name)
      if (existing) {
        // 同名：后者拒绝注册（不覆盖），在**生效的那条**上标 ⚠
        existing.conflict = true
        logger.warn(`tools: duplicate tool '${t.name}': ${existing.serviceId} 生效，${serviceId} 被拒`)
        continue
      }
      byName.set(t.name, record)
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function publishState(): void {
  service.publish('tools.state', {
    tools: catalog(),
    policies: state.policies,
    constraints: state.constraints,
    mcpServers: state.mcpServers,
  })
}

service.subscribe('tool.registered', (payload) => {
  const serviceId = typeof payload.serviceId === 'string' ? payload.serviceId : ''
  const tools = Array.isArray(payload.tools) ? (payload.tools as ToolRecord[]) : []
  if (!serviceId) return
  registered.set(serviceId, tools)
  publishState()
})
service.subscribe('tool.unregistered', (payload) => {
  const serviceId = typeof payload.serviceId === 'string' ? payload.serviceId : ''
  if (serviceId && registered.delete(serviceId)) publishState()
})

// 审批请求：按策略应答。kind:'workspace' 忽略（loop 应答）
service.subscribe('tool.approval.requested', (payload) => {
  const kind = payload.kind === 'workspace' ? 'workspace' : 'exec'
  if (kind !== 'exec') return
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof payload.toolName === 'string' ? payload.toolName : ''
  const risk = (payload.risk as ToolRisk) ?? 'read'
  if (!T || !name) return
  const policy = state.policies[name] ?? RISK_DEFAULT[risk] ?? 'ask'
  if (policy === 'auto') {
    service.publish('tool.approval.resolved', { requestId: T, approved: true })
  } else if (policy === 'deny') {
    service.publish('tool.approval.resolved', { requestId: T, approved: false, reason: '策略为 deny' })
  }
  // ask：不答，等用户
})

// 用户应答：remember → 把该工具策略改成 auto
service.subscribe('tool.approval.resolved', (payload) => {
  if (payload.remember !== true) return
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof (payload as { toolName?: unknown }).toolName === 'string' ? String((payload as { toolName: string }).toolName) : ''
  if (!name) return
  state.policies[name] = 'auto'
  persist()
  publishState()
  void T
})

service.subscribe('tools.list', publishState)

service.subscribe('tools.set', (payload) => {
  let changed = false
  if (payload.policies && typeof payload.policies === 'object') {
    state.policies = { ...state.policies, ...(payload.policies as Record<string, ApprovalPolicy>) }
    changed = true
  }
  if (payload.constraints && typeof payload.constraints === 'object') {
    state.constraints = { ...state.constraints, ...(payload.constraints as Record<string, Record<string, unknown>>) }
    changed = true
  }
  if (changed) {
    persist()
    publishState()
  }
})

service.subscribe('tools.mcp.set', (payload) => {
  if (Array.isArray(payload.servers)) {
    state.mcpServers = payload.servers as MCPServerConfig[]
    persist()
    publishState()
  }
})

service.subscribe('tools.mcp.test', () => {
  // 连通性测试归 mcp-tools；这里仅占位（无 server 时不做事）
})

async function main(): Promise<void> {
  await service.start()
  const dir = service.dataDir || process.env.DS_DATA_DIR
  if (!dir) throw new Error('tools: no dataDir from the handshake')
  dataDir = dir
  const approvals = loadJson<{ policies?: Record<string, ApprovalPolicy> }>('approvals.json', {})
  const constraints = loadJson<Record<string, Record<string, unknown>>>('constraints.json', {})
  const mcp = loadJson<{ servers?: MCPServerConfig[] }>('mcp-servers.json', {})
  state = { policies: approvals.policies ?? {}, constraints, mcpServers: mcp.servers ?? [] }
  logger.info(`tools gate: policies=${Object.keys(state.policies).length} constraints=${Object.keys(state.constraints).length}`)
  publishState()
}

main().catch((err: unknown) => {
  console.error(`tools: failed to start: ${String(err)}`)
  process.exit(1)
})
