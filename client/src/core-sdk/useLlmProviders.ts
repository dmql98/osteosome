import { computed, onMounted, onUnmounted, ref } from 'vue'
import { sse } from './sse'
import type { ProviderDescriptor } from '@osteosome/shared'

/**
 * LLM provider 存在性/状态（P2 WS-8）。
 *
 * 前端**不直连** provider，只经 `llm.provider.registered/unregistered` 被动感知：
 * - `llm-chat` 用它做 provider 下拉 + 默认模型；
 * - `llm-providers` 用它渲染状态列表。
 */
export interface LlmProviderEntry extends ProviderDescriptor {
  registeredAt: number
}

export function useLlmProviders() {
  const providers = ref<Record<string, LlmProviderEntry>>({})

  const list = computed(() =>
    Object.values(providers.value).sort((a, b) => a.provider.localeCompare(b.provider)),
  )

  const registeredAtBase = Date.now()
  let order = 0

  function applyRegistered(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    const provider = typeof p.provider === 'string' && p.provider ? p.provider : ''
    if (!provider) return
    providers.value[provider] = {
      provider,
      defaultModel: typeof p.defaultModel === 'string' ? p.defaultModel : '',
      credentialRef: typeof p.credentialRef === 'string' ? p.credentialRef : '',
      retryPolicy: p.retryPolicy as ProviderDescriptor['retryPolicy'],
      registeredAt: registeredAtBase + order++,
    }
  }

  function applyUnregistered(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const provider = (payload as Record<string, unknown>).provider
    if (typeof provider === 'string' && provider) delete providers.value[provider]
  }

  let disposeRegistered: (() => void) | null = null
  let disposeUnregistered: (() => void) | null = null

  onMounted(() => {
    disposeRegistered = sse.subscribe('llm.provider.registered', applyRegistered)
    disposeUnregistered = sse.subscribe('llm.provider.unregistered', applyUnregistered)
  })
  onUnmounted(() => {
    disposeRegistered?.()
    disposeRegistered = null
    disposeUnregistered?.()
    disposeUnregistered = null
  })

  return { providers, list }
}
