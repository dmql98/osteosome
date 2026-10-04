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
      <!-- 请求参数：provider / 模型 / 思考强度（与消息区无关，只写本地） -->
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
          @update:model-value="setModel(String($event))"
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
          @update:model-value="setThinking(String($event))"
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
          <Button v-if="sending" variant="danger" size="sm" data-testid="composer-stop" @click="cancel">停止</Button>
          <Button v-else type="submit" size="sm" :disabled="!canSend" data-testid="composer-send">发送</Button>
        </div>
      </form>

      <p v-if="failed" class="chat-composer__failed" data-testid="composer-failed">{{ failed }}</p>
    </template>
  </Card>
</template>

<script setup lang="ts">
/**
 * ③ 输入区 —— 只管「输入」与「请求参数」。
 *
 * ## 状态全是本地的：provider / model / thinking / draft 只有这个视图读
 *
 * 搬进插件之前它们在 `chat.store` 里，而 store 是 ② 也读的对象。现在不必了：
 * ② 时间线只关心「这一轮说了什么」，不关心用什么模型发的。
 * 把它们收成本地 ref 之后，这个视图与 ② 之间的耦合**降到了零** ——
 * 它连 curId 都是只读的。
 *
 * ## `sending` 来自 SSE，不是本地布尔
 *
 * 原来 `sending` 是本地状态：点发送置 true，等 `loop.state.changed{idle}` 置 false。
 * 现在它由 `useRunState` 从事件派生 —— 于是**② ③ 两个 iframe 的 sending 必然一致**，
 * 而不需要任何同步。少一个可能不同步的状态。
 *
 * ## provider 列表与模型目录为什么留在组件里
 *
 * `useLlmProviders` / `useModelCatalog` 是**每次调用新建 ref** 的 composable，
 * 靠 `onMounted` 订阅 —— 放进 store 的 getter 里只会拿到空实例。
 * 所以它们留在本组件的 setup 里（这里才是合法的调用上下文）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button, Card, EmptyState, Select, Textarea } from '@osteosome/ui'
import { useLlmProviders, useModelCatalog, usePreferences } from '@osteosome/core-client'
import type { ThinkingEffort } from '@osteosome/shared'
import { cancelRun, currentSessionId, useComposerRun, useRunState, useSessionState } from '../state'

const sessions = useSessionState()
const curId = currentSessionId()
const preferences = usePreferences()
const { list } = useLlmProviders()
const { models, catalog, load } = useModelCatalog()

const run = useRunState({
  curId: () => curId.value,
  messages: () => sessions.messages.value,
  onError: (message) => {
    failed.value = message
  },
})

// ── 请求参数（本地） ────────────────────────────────────────────
const draft = ref('')
const provider = ref('')
const model = ref('')
const thinking = ref<ThinkingEffort>('off')
const failed = ref('')

const sending = computed(() => run.sending.value)
const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value)
const catalogKind = computed(() => catalog.value ?? '')

/**
 * 设置页「逐模型开关」写进 `preferences.llm.enabledModels`，这里是它的**消费方**。
 *
 * 没有这一层过滤，设置页的开关就是个假开关：关掉了、下拉里还选得到 ——
 * 用户会以为功能坏了。格式同设置页：`${provider}::${model}`，空数组 = 全启用。
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

function setModel(value: string): void {
  model.value = value
}

function setThinking(value: string): void {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') {
    thinking.value = value as ThinkingEffort
  }
}

/** 切 provider：模型回落到该家声明默认模型，并拉它的模型目录（能力位：目录由 provider 自己回答） */
async function onSelectProvider(value: string | number): Promise<void> {
  const name = String(value)
  provider.value = name
  model.value = defaultModelOf(name)
  await load(name)
}

const composer = useComposerRun({
  curId: () => curId.value,
  ensureSession: () => sessions.create(),
  recent: () => sessions.recent(),
  provider: () => provider.value,
  model: () => model.value,
  thinking: () => thinking.value,
  onError: (message) => {
    failed.value = message
  },
})

async function submit(): Promise<void> {
  const text = draft.value
  if (!text.trim() || sending.value) return
  // 先清空再发：这一轮的后续全部由 SSE 驱动，发出去的消息会经
  // `message.appended` 回到时间线 —— 不清空的话用户会以为没发出去。
  draft.value = ''
  failed.value = ''
  await composer.submit(text)
}

function cancel(): void {
  cancelRun(run.activeA.value)
}

/** 首个 provider 注册后自动选中（这里是唯一持有 provider 列表的地方） */
watch(
  list,
  (current) => {
    if (!provider.value && current.length > 0) void onSelectProvider(current[0].provider)
  },
  { immediate: true },
)

// 目录到达 → 顺手重读一次开关，并把当前模型校正到「还在的 / 还开着的」
watch(models, (items) => {
  refreshDisabledModels()
  if (items.length === 0) return
  const enabled = visibleModels.value
  if (enabled.includes(model.value)) return
  // 一家的模型全被关掉了：保持原选择（还能真发出去），下拉为空是明确的状态
  if (enabled.length === 0) return
  const fallback = defaultModelOf(provider.value)
  setModel(enabled.includes(fallback) ? fallback : enabled[0])
})

onMounted(() => {
  // 自己 bootstrap：`recent()` 是「没有 curId 时的兜底」，而 curId 也可能是空的
  // （用户还没建过会话）。跨 iframe 拿 ① 的列表是我们要避免的形态，理由见
  // `state/index.ts` 的纪律与 ChatTimelineView 里的同款注释。
  void sessions.bootstrap()
  refreshDisabledModels()
  run.bindEvents()
})

onBeforeUnmount(() => {
  run.dispose()
  sessions.dispose()
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
.chat-composer__failed {
  padding: var(--space-2) var(--space-3); border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm); color: var(--color-danger); font-size: var(--text-xs);
}
</style>