/**
 * tools UI 状态层（P7）—— 只读 `tools.state` / 审批请求；写走 `tools.set` / `tools.invoke` / `tool.approval.resolved`。
 */
import { ref, type Ref } from 'vue'
import { sse, useCommand } from '@osteosome/core-client'
import type { ApprovalPolicy, ConstraintValues, MCPServerConfig, ToolRecord, ToolRisk } from '@osteosome/shared'

export interface PendingApproval {
  requestId: string
  sessionId: string
  toolName: string
  risk: ToolRisk
  kind: 'exec' | 'workspace'
  arguments: string
  requestedPath?: string
  permissionRoot?: string
  rationale?: string
}

const tools = ref<ToolRecord[]>([])
const policies = ref<Record<string, ApprovalPolicy>>({})
const constraints = ref<ConstraintValues>({})
const mcpServers = ref<MCPServerConfig[]>([])
const pending = ref<PendingApproval[]>([])
const events = ref<{ topic: string; summary: string; at: number }[]>([])
let bound = false

function pushEvent(topic: string, summary: string): void {
  events.value = [{ topic, summary, at: Date.now() }, ...events.value].slice(0, 50)
}

export function useToolsState(): {
  tools: Ref<ToolRecord[]>
  policies: Ref<Record<string, ApprovalPolicy>>
  constraints: Ref<ConstraintValues>
  mcpServers: Ref<MCPServerConfig[]>
  pending: Ref<PendingApproval[]>
  events: Ref<{ topic: string; summary: string; at: number }[]>
  bind: () => void
  dispose: () => void
  setPolicy: (name: string, policy: ApprovalPolicy) => Promise<boolean>
  setConstraint: (name: string, key: string, value: unknown) => Promise<boolean>
  setMcpServers: (servers: MCPServerConfig[]) => Promise<boolean>
  resolveApproval: (requestId: string, approved: boolean, remember?: boolean) => Promise<boolean>
  invoke: (name: string, args: Record<string, unknown>) => Promise<void>
  lastInvoke: Ref<{ ok: boolean; content: string; summary: string; elapsedMs: number } | null>
} {
  const lastInvoke = ref<{ ok: boolean; content: string; summary: string; elapsedMs: number } | null>(null)
  let pendingInvoke: ((r: { ok: boolean; content: string; summary: string; elapsedMs: number }) => void) | null = null
  return {
    tools,
    policies,
    constraints,
    mcpServers,
    pending,
    events,
    lastInvoke,
    bind: () => {
      if (bound) return
      bound = true
      sse.subscribe('tools.state', (payload) => {
        const p = payload as { tools?: ToolRecord[]; policies?: Record<string, ApprovalPolicy>; constraints?: ConstraintValues; mcpServers?: MCPServerConfig[] } | null
        if (!p) return
        if (Array.isArray(p.tools)) tools.value = p.tools
        policies.value = p.policies ?? {}
        constraints.value = p.constraints ?? {}
        mcpServers.value = p.mcpServers ?? []
        pushEvent('tools.state', `${tools.value.length} 个工具`)
      })
      sse.subscribe('tool.execute.result', (payload) => {
        const p = payload as { requestId?: string; ok?: boolean; summary?: string } | null
        if (p?.requestId) pushEvent('tool.execute.result', `${p.ok ? '✓' : '✗'} ${p.summary ?? ''}`)
      })
      sse.subscribe('tool.approval.requested', (payload) => {
        const p = payload as PendingApproval | null
        if (!p?.requestId) return
        if (!pending.value.some((x) => x.requestId === p.requestId)) {
          pending.value = [...pending.value, { ...p, kind: p.kind === 'workspace' ? 'workspace' : 'exec' }]
          pushEvent('tool.approval.requested', `${p.kind === 'workspace' ? '工作区' : '执行'} · ${p.toolName}`)
        }
      })
      sse.subscribe('tool.approval.resolved', (payload) => {
        const id = (payload as { requestId?: string } | null)?.requestId
        if (id) pending.value = pending.value.filter((x) => x.requestId !== id)
      })
      sse.subscribe('tools.invoke.result', (payload) => {
        const p = payload as { ok?: boolean; content?: string; summary?: string; elapsedMs?: number } | null
        if (!p) return
        const r = { ok: p.ok === true, content: p.content ?? '', summary: p.summary ?? '', elapsedMs: p.elapsedMs ?? 0 }
        lastInvoke.value = r
        pendingInvoke?.(r)
        pendingInvoke = null
      })
    },
    dispose: () => {
      bound = false
    },
    async setPolicy(name, policy) {
      const { send } = useCommand()
      return send('tools.set', { requestId: `pol-${Date.now()}`, policies: { [name]: policy } })
    },
    async setConstraint(name, key, value) {
      const { send } = useCommand()
      return send('tools.set', { requestId: `con-${Date.now()}`, constraints: { [name]: { [key]: value } } })
    },
    async setMcpServers(servers) {
      const { send } = useCommand()
      return send('tools.mcp.set', { requestId: `mcp-${Date.now()}`, servers })
    },
    async resolveApproval(requestId, approved, remember) {
      const { send } = useCommand()
      const ok = await send('tool.approval.resolved', { requestId, approved, ...(remember ? { remember } : {}) })
      if (ok) pending.value = pending.value.filter((x) => x.requestId !== requestId)
      return ok
    },
    async invoke(name, args) {
      const { send } = useCommand()
      pendingInvoke = (r) => {
        lastInvoke.value = r
      }
      await send('tools.invoke', { requestId: `inv-${Date.now()}`, name, arguments: JSON.stringify(args) })
    },
  }
}
