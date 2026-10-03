import { computed, onMounted, onUnmounted, ref } from 'vue'
import { sse } from './sse'
import { useCommand } from './useCommand'
import type { ProviderDescriptor } from '@osteosome/shared'

/**
 * LLM provider 存在性/状态（P2 WS-8）。
 *
 * 前端**不直连** provider，只经 `llm.provider.registered/unregistered` 被动感知：
 * - `llm-chat` 用它做 provider 下拉 + 默认模型；
 * - `llm-providers` 用它渲染状态列表。
 *
 * ## 挂载后必须主动问一次「现在都有谁」
 *
 * 纯事件驱动有个致命前提：**订阅要早于事件发生**。而注册事件是在服务进程握手完成时
 * 就发完的 —— 任何在启动之后才打开的页面（模型配置窗、插件详情窗、独立窗口…）
 * 都会**永远错过**那批事件，于是把已经连上的服务显示成「未连接」。
 *
 * 所以挂载时发一次 `llm.provider.reannounce`，让服务重播当前清单。
 * 这不是「轮询」，是一次性的状态对齐。
 */
export interface LlmProviderEntry extends ProviderDescriptor {
  registeredAt: number
}

export function useLlmProviders() {
  const providers = ref<Record<string, LlmProviderEntry>>({})
  /** 是否已拿到过初始清单（用于避免重复对齐） */
  const synced = ref(false)

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
    // 状态对齐：订阅已就位，现在问一次「当前有哪些 provider」。
    // 放在 subscribe 之后 —— 反了就又变成「问的时候还没准备好听」。
    void useCommand().send('llm.provider.reannounce')
    synced.value = true
  })
  onUnmounted(() => {
    disposeRegistered?.()
    disposeRegistered = null
    disposeUnregistered?.()
    disposeUnregistered = null
  })

  return { providers, list, synced }
}
