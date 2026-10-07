/**
 * agents UI 的状态层（P5）—— 只读订阅 `agent.state` + 写走 `agent.state.set`。
 *
 * 单视图，所以用模块级 ref（与 models UI 的做法一致：一个 iframe 里只有一个视图）。
 * 事件日志给「事件」Tab 用；它是**排障视图**，不参与业务。
 */
import { ref, type Ref } from 'vue'
import { sse, useCommand } from '@osteosome/core-client'
import type { AgentStatePatch, CharacterBrief } from '@osteosome/shared'

export interface AgentEventRow {
  /** 事件 topic */
  topic: string
  /** 一行摘要 */
  summary: string
  at: number
}

const characters = ref<CharacterBrief[]>([])
const events = ref<AgentEventRow[]>([])
let bound = false

function pushEvent(topic: string, summary: string): void {
  events.value = [{ topic, summary, at: Date.now() }, ...events.value].slice(0, 50)
}

export interface AgentUiState {
  characters: Ref<CharacterBrief[]>
  events: Ref<AgentEventRow[]>
  bind: () => void
  dispose: () => void
  setPatch: (patch: AgentStatePatch) => Promise<boolean>
  refresh: () => Promise<boolean>
}

export function useAgentState(): AgentUiState {
  return {
    characters,
    events,
    bind: () => {
      if (bound) return
      bound = true
      sse.subscribe('agent.state', (payload) => {
        const c = (payload as { characters?: unknown } | null)?.characters
        if (Array.isArray(c)) {
          characters.value = c as CharacterBrief[]
          pushEvent('agent.state', `${characters.value.length} 个角色`)
        }
      })
      sse.subscribe('prompt.fragment.registered', (payload) => {
        const p = payload as { id?: string } | null
        pushEvent('prompt.fragment.registered', p?.id ?? '')
      })
      sse.subscribe('prompt.fragment.unregistered', (payload) => {
        const p = payload as { id?: string } | null
        pushEvent('prompt.fragment.unregistered', p?.id ?? '')
      })
    },
    dispose: () => {
      bound = false
      events.value = []
    },
    async setPatch(patch: AgentStatePatch): Promise<boolean> {
      const { send } = useCommand()
      return send('agent.state.set', { requestId: `ag-${Date.now()}-${Math.random().toString(16).slice(2)}`, patch })
    },
    async refresh(): Promise<boolean> {
      // agent 服务收到 prompt.fragments.list 时会重播目录 + 片段（见服务端注释）
      const { send } = useCommand()
      return send('prompt.fragments.list', {})
    },
  }
}
