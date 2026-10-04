<template>
  <Card title="输入" class="chat-composer">
    <div v-if="!providerOptions.length" class="chat-composer__no-provider">
      <EmptyState
        icon="🔌"
        title="尚未注册任何 provider"
        description="在设置里配置一家服务商的 API Key，它就会出现在这里。"
      />
    </div>

    <template v-else>
      <!-- 请求参数：provider / 模型 / 思考强度（与消息区无关，只写 store） -->
      <div class="chat-composer__params">
        <Select
          :model-value="provider"
          :options="providerOptions"
          aria-label="选择 provider"
          data-testid="composer-provider"
          @update:model-value="onSelectProvider"
        />
        <Select
          :model-value="model"
          :options="modelOptions"
          aria-label="选择模型"
          data-testid="composer-model"
          @update:model-value="chat.setModel(String($event))"
        />
        <span
          v-if="catalogKind === 'static'"
          class="chat-composer__badge"
          title="未能从服务商拉取模型列表，显示内置列表"
          data-testid="composer-static-badge"
        >
          静态
        </span>
        <Select
          :model-value="thinking"
          :options="thinkingOptions"
          aria-label="思考强度"
          data-testid="composer-thinking"
          @update:model-value="chat.setThinking(String($event))"
        />
      </div>

      <form class="chat-composer__form" @submit.prevent="submit">
        <Textarea
          v-model="draft"
          placeholder="输入消息，Enter 发送"
          :disabled="sending"
          :rows="2"
          auto-grow
          aria-label="消息输入"
          data-testid="composer-input"
        />
        <div class="chat-composer__actions">
          <Button v-if="sending" variant="danger" size="sm" data-testid="composer-stop" @click="chat.cancel">
            停止
          </Button>
          <Button v-else type="submit" size="sm" :disabled="!canSend" data-testid="composer-send">发送</Button>
        </div>
      </form>
    </template>
  </Card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Button } from '@osteosome/ui'
import { Card } from '@osteosome/ui'
import { EmptyState } from '@osteosome/ui'
import { Select } from '@osteosome/ui'
import { Textarea } from '@osteosome/ui'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { useModelCatalog } from '@/core-sdk/useModelCatalog'
import { usePreferences } from '@/core-sdk/usePreferences'
import { useChatStore } from '@/stores/chat.store'
import { useSessionStore } from '@/stores/session.store'

/**
 * ③ 输入区 —— 只管「输入」与「请求参数」。
 *
 * 与 ② timeline **零直接通信**：两者只共享 `chat.store`。
 * `disabled` / `canSend` 这些跨组件状态因此不需要组件间传参或事件桥。
 *
 * ## 为什么 provider 列表与模型目录在这里而不在 store
 *
 * `useLlmProviders` / `useModelCatalog` 是**每次调用新建 ref** 的 composable，靠 `onMounted`
 * 订阅 —— 放进 store 的 getter 里只会拿到空实例（详见 chat.store 的注释）。
 * 所以它们留在本组件的 setup 里（这里才是合法的调用上下文），
 * 选中后把结果写进 store，store 只接收「选了什么」。
 */
const chat = useChatStore()
const sessions = useSessionStore()
const preferences = usePreferences()
const { list } = useLlmProviders()
const { models, catalog, load } = useModelCatalog()

/**
 * 设置页「逐模型开关」写进 `preferences.llm.enabledModels`，这里是它的**消费方**。
 *
 * 没有这一层过滤，设置页的开关就是个假开关：关掉了、下拉里还选得到 ——
 * 用户会以为功能坏了。格式同设置页：`${provider}::${model}`，空数组 = 全启用。
 *
 * 为什么只在挂载 + 目录到达时读：Core 没有「偏好已改」的 SSE 广播
 * （`PUT /api/preferences` 只回 `{ok:true}`），所以拿不到推送。
 * 目录到达正好是「用户刚可能动过设置」的时机 —— 切 provider、点获取模型列表都会触发。
 */
const disabledModels = ref<string[]>([])

function refreshDisabledModels(): void {
  void preferences
    .get()
    .then((prefs) => {
      const raw = (prefs as { llm?: { enabledModels?: unknown } }).llm?.enabledModels
      disabledModels.value = Array.isArray(raw) ? (raw as string[]) : []
    })
    .catch(() => {
      // 读不到就当全启用 —— 偏好坏了不该让输入框变成空下拉
      disabledModels.value = []
    })
}

// 直接双向绑 store 的字段（Pinia 的 writable state）
const draft = computed({
  get: () => chat.draft,
  set: (v: string) => {
    chat.draft = v
  },
})
const provider = computed(() => chat.provider)
const model = computed(() => chat.model)
const thinking = computed(() => chat.thinking)
const sending = computed(() => chat.sending)
const canSend = computed(() => chat.canSend)
const catalogKind = computed(() => catalog.value ?? '')

/** 当前 provider 下没被关掉的模型 */
const visibleModels = computed(() =>
  models.value.filter((m) => !disabledModels.value.includes(`${provider.value}::${m}`)),
)

const providerOptions = computed(() => list.value.map((p) => ({ label: p.provider, value: p.provider })))

/**
 * 目录到达前只有「声明默认模型」一项（仍可真发出去）；
 * 到达后取**没被设置页关掉的**那些 —— 一个都不剩时下拉就是空的，
 * 不该偷偷退回全量，那等于开关没生效。
 */
const modelOptions = computed(() => {
  if (models.value.length === 0) return model.value ? [{ label: model.value, value: model.value }] : []
  return visibleModels.value.map((m) => ({ label: m, value: m }))
})

const thinkingOptions = [
  { label: '思考：关', value: 'off' },
  { label: '思考：低', value: 'low' },
  { label: '思考：中', value: 'medium' },
  { label: '思考：高', value: 'high' },
]

/** provider 的声明默认模型（目录未到达时的兜底，也是目录不含它时的优先回落） */
function defaultModelOf(target: string): string {
  return list.value.find((p) => p.provider === target)?.defaultModel ?? ''
}

/** 切 provider：模型回落到该家声明默认模型，并拉它的模型目录（能力位：目录由 provider 自己回答） */
async function onSelectProvider(value: string | number): Promise<void> {
  const name = String(value)
  chat.setProvider(name, defaultModelOf(name))
  await load(name)
}

function submit(): void {
  void chat.submit()
}

/** 首个 provider 注册后自动选中（原来在组件里，拆分后归 ③ —— 它是唯一持有 provider 列表的地方） */
watch(
  list,
  (current) => {
    if (!chat.provider && current.length > 0) void onSelectProvider(current[0].provider)
  },
  { immediate: true },
)

// 目录到达 → 顺手重读一次开关，并把当前模型校正到「还在的 / 还开着的」
watch(models, (items) => {
  refreshDisabledModels()
  if (items.length === 0) return
  const enabled = visibleModels.value
  if (enabled.includes(chat.model)) return
  // 一家的模型全被关掉了：保持原选择（还能真发出去），下拉为空是明确的状态
  if (enabled.length === 0) return
  const fallback = defaultModelOf(chat.provider)
  chat.setModel(enabled.includes(fallback) ? fallback : enabled[0])
})

// 切会话 → 重置本地 in-flight + 载入历史（② 也读同一个 store，两边自动同步）
watch(
  () => sessions.curId,
  (sessionId) => void chat.onSessionChanged(sessionId),
  { immediate: true },
)

onMounted(() => {
  refreshDisabledModels()
  chat.bindEvents()
})
</script>

<style scoped>
.chat-composer { display: flex; flex-direction: column; gap: var(--space-3); }
.chat-composer__params { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.chat-composer__badge {
  font-size: var(--text-xs); color: var(--color-warning); border: 1px solid var(--color-warning);
  border-radius: var(--radius-sm); padding: 1px var(--space-2); white-space: nowrap;
}
.chat-composer__form { display: grid; gap: var(--space-2); }
.chat-composer__actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.chat-composer__no-provider { color: var(--color-text-muted); }
</style>
