/**
 * 角色目录的**只读**订阅（P5）—— composer 的角色下拉用。
 *
 * 它是 models 的 `useModelsPrefs` / `useLlmProviders` 的同款：owner（agent 服务）
 * 每次变更重播整份 `agent.state`，订阅方不需要 diff。
 *
 * **没装 agents 插件 = 收不到任何 `agent.state`** → 列表保持空 → 下拉不出现，
 * 会话回落裸会话（「缺失是合法的」）。这里**不做**「发命令去问」的补充：
 * 问也没人答，且会平白多一条订阅后重连。
 */
import { ref, type Ref } from 'vue'
import { sse } from '@osteosome/core-client'
import type { CharacterBrief } from '@osteosome/shared'

export interface CharacterList {
  characters: Ref<CharacterBrief[]>
  bind: () => void
  dispose: () => void
}

export function useCharacters(): CharacterList {
  const characters = ref<CharacterBrief[]>([])
  let unsub: (() => void) | null = null
  return {
    characters,
    bind: () => {
      if (unsub) return
      unsub = sse.subscribe('agent.state', (payload) => {
        const c = (payload as { characters?: unknown } | null)?.characters
        if (Array.isArray(c)) characters.value = c as CharacterBrief[]
      })
    },
    dispose: () => {
      unsub?.()
      unsub = null
    },
  }
}
