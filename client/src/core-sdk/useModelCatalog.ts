import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useCommand } from './useCommand'
import { sse } from './sse'

/**
 * 模型目录（P4 WS-2）—— `llm.models.list` → `llm.models.list.result` 的共用 composable。
 *
 * 为什么抽出来：`LlmSettings.vue`（P4 WS-4）与 `LlmChatWidget.vue`（P4 WS-3）都要
 * 「选 provider → 拉该 provider 的模型列表 → remote/static 角标」，此前只有设置页有这份逻辑。
 *
 * 语义：
 * - 目录是 **provider 自己的知识**（能力位设计）——前端只发命令，不查上游；
 * - `catalog:'static'` = 上游拉取失败/超时 → provider 降级到内置列表（可能不全，UI 挂角标）；
 * - 线上字段叫 `catalog` 不叫 `source`（`source` 是总线保留字段，会被 ServiceManager 盖章成
 *   serviceId —— 见 `shared/src/events.ts` 的说明），本地变量名沿用 `catalog` 以免再混淆；
 * - 结果按 **provider** 匹配而非 requestId：同一 provider 的重复请求结果等价，
 *   切换 provider 后旧结果因 provider 不符被丢弃（避免 requestId 竞态导致列表闪空）。
 */
export interface ModelCatalogEntry {
  provider: string
  models: string[]
  catalog: 'remote' | 'static'
}

export function useModelCatalog() {
  /** 当前目录所属 provider（'' = 未选） */
  const provider = ref('')
  const models = ref<string[]>([])
  /** null = 尚未拉取；'remote'/'static' 见 ModelCatalogEntry */
  const catalog = ref<'remote' | 'static' | null>(null)
  const loading = ref(false)

  /** options 供 Select 直接消费 */
  const options = computed(() => models.value.map((m) => ({ label: m, value: m })))

  /** 拉取某 provider 的目录（切 provider 会先清空当前列表，避免展示上一家的模型） */
  async function load(target: string): Promise<void> {
    provider.value = target
    models.value = []
    catalog.value = null
    if (!target) return
    loading.value = true
    const { send } = useCommand()
    await send('llm.models.list', { requestId: `models-${Date.now()}-${Math.random().toString(16).slice(2)}`, provider: target })
  }

  function applyResult(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    if (p.provider !== provider.value) return
    models.value = Array.isArray(p.models) ? (p.models as unknown[]).filter((m): m is string => typeof m === 'string') : []
    catalog.value = p.catalog === 'remote' ? 'remote' : 'static'
    loading.value = false
  }

  let dispose: (() => void) | null = null

  onMounted(() => {
    dispose = sse.subscribe('llm.models.list.result', applyResult)
  })
  onUnmounted(() => {
    dispose?.()
    dispose = null
  })

  return { provider, models, catalog, loading, options, load }
}