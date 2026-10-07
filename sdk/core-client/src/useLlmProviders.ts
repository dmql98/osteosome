import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { sse } from './sse'
import { useCommand } from './useCommand'
import type { ProviderDescriptor } from '@osteosome/shared'

/**
 * LLM provider 存在性/状态（P2 WS-8）。
 *
 * 前端**不直连** provider，只经 `llm.provider.registered/unregistered` 被动感知：
 * `llm-settings`（模型接入面板）用它渲染「已连接 / 未连接」两张名单，
 * `chat-composer` 用它做 provider 下拉 + 默认模型。
 * 原先还有一个只读的 `widget.llm-providers` 状态面板，也用它，已随该组件删除。
 *
 * ## 挂载后必须主动问一次「现在都有谁」
 *
 * 纯事件驱动有个致命前提：**订阅要早于事件发生**。而注册事件是在服务进程握手完成时
 * 就发完的 —— 任何在启动之后才打开的页面（模型配置窗、插件详情窗、独立窗口…）
 * 都会**永远错过**那批事件，于是把已经连上的服务显示成「未连接」。
 *
 * 所以要问一次 `llm.provider.reannounce`，让服务重播当前清单。
 * 这不是「轮询」，是一次性的状态对齐。
 *
 * ## 但「subscribe 完就问」是不够的 —— 必须等连接真的建立
 *
 * `sse.subscribe()` 只是**创建**了一个 EventSource：请求还没发出去，对端也还没登记
 * 这条流。这时候紧接着发问，问回来的清单会投递给**空气**。
 *
 * 实测（Chrome + Vite dev 代理，时间轴取自 DevTools 协议）：
 *
 * ```
 *   82ms  POST /api/command          ← reannounce 已发出
 *   84ms  GET  /events?topics=…      ← EventSource 才刚把请求发出去
 *   90ms  200  /events
 * ```
 *
 * 服务在 84ms 之前就回放了清单，而 Core 登记这条流是在 84ms 之后 —— **事件全丢**，
 * 而且没有任何东西会再来一次（EventSource 不会重播，服务也不会周期重发）。
 * 于是 provider 下拉永远是空的（会话页显示「尚未注册任何 provider」），
 * 连带模型接入页那条「注册了就自动探一次」的 watch 也不会跑，卡片永远停在「未测试」。
 *
 * 所以对齐的触发条件是 **`state === 'connected'`**（`open` 已到达 = 流已登记），
 * 而且**每次重连都重新问一次** —— 漏掉的那一次由此自愈，不必再写重试或退避。
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
  let stopAlign: (() => void) | null = null

  onMounted(() => {
    disposeRegistered = sse.subscribe('llm.provider.registered', applyRegistered)
    disposeUnregistered = sse.subscribe('llm.provider.unregistered', applyUnregistered)
    // 状态对齐：只在**连接已建立**时问（理由见文件头）。
    // `immediate` 覆盖「挂载时这条流本来就是通的」——共用同一个 sse 实例的第二个组件
    // 不会再经历一次 open，不 immediate 就会一直等一个不会来的状态变化。
    stopAlign = watch(
      () => sse.getState(),
      (state) => {
        if (state !== 'connected') return
        void useCommand().send('llm.provider.reannounce')
        synced.value = true
      },
      { immediate: true },
    )
  })
  onUnmounted(() => {
    stopAlign?.()
    stopAlign = null
    disposeRegistered?.()
    disposeRegistered = null
    disposeUnregistered?.()
    disposeUnregistered = null
  })

  return { providers, list, synced }
}
