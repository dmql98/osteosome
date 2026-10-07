/**
 * skills UI 状态层（P6）—— 只读 `skills.state` + `agent.state`（算角色绑定数）；
 * 写走 `skill.enabled.set`。单视图，模块级 ref。
 */
import { ref, type Ref } from 'vue'
import { sse, useCommand } from '@osteosome/core-client'
import type { CharacterBrief, SkillIndexEntry } from '@osteosome/shared'

const skills = ref<SkillIndexEntry[]>([])
const characters = ref<CharacterBrief[]>([])
let bound = false

export interface SkillsUiState {
  skills: Ref<SkillIndexEntry[]>
  characters: Ref<CharacterBrief[]>
  bind: () => void
  dispose: () => void
  setEnabled: (ownerPluginId: string, name: string, enabled: boolean) => Promise<boolean>
  refresh: () => Promise<boolean>
}

export function useSkillsState(): SkillsUiState {
  return {
    skills,
    characters,
    bind: () => {
      if (bound) return
      bound = true
      sse.subscribe('skills.state', (payload) => {
        const s = (payload as { skills?: unknown } | null)?.skills
        if (Array.isArray(s)) skills.value = s as SkillIndexEntry[]
      })
      sse.subscribe('agent.state', (payload) => {
        const c = (payload as { characters?: unknown } | null)?.characters
        if (Array.isArray(c)) characters.value = c as CharacterBrief[]
      })
    },
    dispose: () => {
      bound = false
    },
    async setEnabled(ownerPluginId: string, name: string, enabled: boolean): Promise<boolean> {
      const { send } = useCommand()
      return send('skill.enabled.set', {
        requestId: `sk-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ownerPluginId,
        name,
        enabled,
      })
    },
    async refresh(): Promise<boolean> {
      // 请求重播：skills.list（无 characterId）+ prompt.fragments.list 都会让服务重播 skills.state
      const { send } = useCommand()
      const a = await send('prompt.fragments.list', {})
      return a
    },
  }
}
