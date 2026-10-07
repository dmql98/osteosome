import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { sse } from './sse'
import { useCommand } from './useCommand'
import { emptyModelsPrefs, type MaskedCredential, type ModelsPrefs } from '@osteosome/shared'

/**
 * models 插件的用户数据（接入清单 / 自填端点 / 模型开关）—— 总线读写。
 *
 * ## 为什么 UI 不再走 `/api/preferences`
 *
 * 这份数据的所有者是 **models 插件的服务**（它把密钥变成 `Authorization` 头，所以密钥与
 * 清单都该在它那儿）。于是「谁能改它」也归它：Core 不持有、不转发、不解释这些键。
 * 前端经 `/api/command` → 总线读写，Core 只当那条命令的通道。
 *
 * 迁移自 `preferences.llm.*`（`<dataDir>/core/preferences.json`）与 `/api/credentials`。
 *
 * ## 为什么「问一次」要等连接建立
 *
 * 与 `useLlmProviders` 同一个坑：subscribe 只是**创建** EventSource，请求还没发出去，
 * 对端也还没登记这条流。那一刻发出去的 `models.prefs.get` 会得到一片寂静，
 * 而且没人会再来一次。所以对齐的触发条件是 `state === 'connected'`，
 * 且**每次重连都重问**（漏掉的那次由此自愈）。
 */
export function useModelsPrefs(): {
  prefs: Ref<ModelsPrefs>
  /** 已拿到过至少一份（与「拿到的是空清单」区分开，空清单也是合法状态） */
  synced: Ref<boolean>
  /** 合并式改：没给的键保持原样 */
  patch: (patch: Partial<ModelsPrefs>) => Promise<void>
} {
  const prefs = ref<ModelsPrefs>(emptyModelsPrefs())
  const synced = ref(false)

  function applyState(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const incoming = (payload as { prefs?: unknown }).prefs
    if (!incoming || typeof incoming !== 'object') return
    // 容错：owner 是别的进程，它给的形状不该让界面崩在一个 undefined 上
    const p = incoming as Partial<ModelsPrefs>
    prefs.value = {
      connectedVendors: Array.isArray(p.connectedVendors) ? p.connectedVendors : [],
      vendorOverrides: Array.isArray(p.vendorOverrides) ? p.vendorOverrides : [],
      enabledModels: Array.isArray(p.enabledModels) ? p.enabledModels : [],
    }
    synced.value = true
  }

  let dispose: (() => void) | null = null
  let stopAlign: (() => void) | null = null

  onMounted(() => {
    dispose = sse.subscribe('models.prefs.state', applyState)
    stopAlign = watch(
      () => sse.getState(),
      (state) => {
        if (state !== 'connected') return
        void useCommand().send('models.prefs.get')
      },
      { immediate: true },
    )
  })
  onUnmounted(() => {
    stopAlign?.()
    stopAlign = null
    dispose?.()
    dispose = null
  })

  async function patch(delta: Partial<ModelsPrefs>): Promise<void> {
    await useCommand().send('models.prefs.set', { patch: delta })
  }

  return { prefs, synced, patch }
}

/**
 * models 插件的密钥（**掩码列表**）—— 总线读写。
 *
 * 明文只走「前端 → Core `/api/command` → 总线 → owner」这一条路，owner 回的一律掩码，
 * 任何事件 / SSE 里都不会出现原值。所以这里**没有** `get(id)` 这样的入口 ——
 * 不是暂时没做，是这条通道按设计就不给读原值。
 */
export function useModelCredentials(): {
  credentials: Ref<MaskedCredential[]>
  synced: Ref<boolean>
  put: (input: { id?: string; name: string; provider: string; value: string }) => Promise<void>
  remove: (id: string) => Promise<void>
} {
  const credentials = ref<MaskedCredential[]>([])
  const synced = ref(false)

  function applyState(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const list = (payload as { credentials?: unknown }).credentials
    if (!Array.isArray(list)) return
    credentials.value = list as MaskedCredential[]
    synced.value = true
  }

  let dispose: (() => void) | null = null
  let stopAlign: (() => void) | null = null

  onMounted(() => {
    dispose = sse.subscribe('models.credentials.state', applyState)
    stopAlign = watch(
      () => sse.getState(),
      (state) => {
        if (state !== 'connected') return
        void useCommand().send('models.credentials.list')
      },
      { immediate: true },
    )
  })
  onUnmounted(() => {
    stopAlign?.()
    stopAlign = null
    dispose?.()
    dispose = null
  })

  return {
    credentials,
    synced,
    async put(input) {
      await useCommand().send('models.credentials.put', input)
    },
    async remove(id) {
      await useCommand().send('models.credentials.delete', { id })
    },
  }
}

/** `enabledModels` 的便捷读取（会话输入框只要这一项，不必拿整份清单） */
export function useEnabledModels(): Ref<string[]> {
  const { prefs } = useModelsPrefs()
  return computed(() => prefs.value.enabledModels) as Ref<string[]>
}