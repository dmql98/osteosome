/**
 * tools UI 状态层（P7）—— 只读 `tools.state` / 审批请求；写走 `tools.set` / `tools.invoke` / `tool.approval.resolved`。
 *
 * ## 打开面板时为什么要主动问一次（`tools.list`）
 *
 * `tools.state` 是**闸门在变化时**播的（有人注册 / 改策略 / MCP 变更）。而这块面板
 * 往往是用户之后才打开的第二块界面 —— 那时闸门早就播完了，订阅只是建了一条流、
 * 不会重放历史。于是面板永远显示「目录为空」，而对话里其实能正常调工具：
 * 两个界面互相看不见，用户只会觉得「工具坏了」。
 *
 * 所以与 models / agents 面板同一套处置：**SSE 连上就问一次**（`tools.list`），
 * 闸门收到就整份重播；执行者收到还会顺便重播注册。每次重连都重问 ——
 * 漏掉的那次由此自愈，不用用户去点「刷新」。
 */
import { ref, watch, type Ref } from 'vue'
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
/**
 * 本次 bind 挂上的订阅摘除器 —— **必须在 dispose 里调用**。
 * 不摘的话重开面板会累积 handler，同一条事件被处理 N 次
 * （症状是「事件」列表里同一条重复出现，很难联想到是订阅没摘）。
 */
let offs: Array<() => void> = []
/** SSE 连上就询问目录的 watcher（见 `bind` 里的注释） */
let stopAlign: (() => void) | null = null

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
      const sub = (topic: string, handler: (payload: unknown) => void): void => {
        offs.push(sse.subscribe(topic, handler))
      }
      sub('tools.state', (payload) => {
        const p = payload as { tools?: ToolRecord[]; policies?: Record<string, ApprovalPolicy>; constraints?: ConstraintValues; mcpServers?: MCPServerConfig[] } | null
        if (!p) return
        if (Array.isArray(p.tools)) tools.value = p.tools
        policies.value = p.policies ?? {}
        constraints.value = p.constraints ?? {}
        mcpServers.value = p.mcpServers ?? []
        pushEvent('tools.state', `${tools.value.length} 个工具`)
      })
      sub('tool.execute.result', (payload) => {
        const p = payload as { requestId?: string; ok?: boolean; summary?: string } | null
        if (p?.requestId) pushEvent('tool.execute.result', `${p.ok ? '✓' : '✗'} ${p.summary ?? ''}`)
      })
      sub('tool.approval.requested', (payload) => {
        const p = payload as PendingApproval | null
        if (!p?.requestId) return
        if (!pending.value.some((x) => x.requestId === p.requestId)) {
          pending.value = [...pending.value, { ...p, kind: p.kind === 'workspace' ? 'workspace' : 'exec' }]
          pushEvent('tool.approval.requested', `${p.kind === 'workspace' ? '工作区' : '执行'} · ${p.toolName}`)
        }
      })
      sub('tool.approval.resolved', (payload) => {
        const id = (payload as { requestId?: string } | null)?.requestId
        if (id) pending.value = pending.value.filter((x) => x.requestId !== id)
      })
      sub('tools.invoke.result', (payload) => {
        const p = payload as { ok?: boolean; content?: string; summary?: string; elapsedMs?: number } | null
        if (!p) return
        const r = { ok: p.ok === true, content: p.content ?? '', summary: p.summary ?? '', elapsedMs: p.elapsedMs ?? 0 }
        lastInvoke.value = r
        pendingInvoke?.(r)
        pendingInvoke = null
      })
      /**
       * **连上就问一次目录**。
       *
       * `tools.state` 是「闸门变化时」才播的：打开这个面板时闸门往往早已播完，
       * 而订阅只是建了一条流、不会重放历史 —— 于是面板一直显示「目录为空」，
       * 而对话里其实能正常调工具。`tools.list` 会让闸门整份重播（执行者收到还会重播注册）。
       *
       * 每次重连都重问：漏掉的那次由此自愈，不需要用户去点「刷新」。
       */
      stopAlign = watch(
        () => sse.getState(),
        (state) => {
          if (state !== 'connected') return
          void useCommand().send('tools.list')
        },
        { immediate: true },
      )
    },
    dispose: () => {
      if (!bound) return
      bound = false
      for (const off of offs) off()
      offs = []
      stopAlign?.()
      stopAlign = null
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

/**
 * 仅测试用：把模块级单例清回初值。
 *
 * 这块状态是**模块级 ref**（多个视图共享一份目录），所以用例之间会互相污染：
 * 上一个用例渲染出的工具、累积的事件列表都会留到下一个用例，
 * 症状是「单独跑绿、一起跑红」。与 `chat-workbench` 的
 * `__resetSessionSyncForTest` 同一处置。
 */
export function __resetToolsStateForTest(): void {
  for (const off of offs) off()
  offs = []
  stopAlign?.()
  stopAlign = null
  bound = false
  tools.value = []
  policies.value = {}
  constraints.value = {}
  mcpServers.value = []
  pending.value = []
  events.value = []
}
