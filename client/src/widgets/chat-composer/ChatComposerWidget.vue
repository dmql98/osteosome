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
import { computed, onMounted, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Select from '@/components/ui/Select.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { useModelCatalog } from '@/core-sdk/useModelCatalog'
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
const { list } = useLlmProviders()
const { models, catalog, load } = useModelCatalog()

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

const providerOptions = computed(() => list.value.map((p) => ({ label: p.provider, value: p.provider })))

/** 目录到达前只有「声明默认模型」一项（仍可真发出去）；到达后取全量 */
const modelOptions = computed(() => {
  const items = models.value.length > 0 ? models.value : model.value ? [model.value] : []
  return items.map((m) => ({ label: m, value: m }))
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

// 目录到达 → 校正当前模型选择（不在目录里才动）
watch(models, (items) => {
  if (items.length === 0 || items.includes(chat.model)) return
  const fallback = defaultModelOf(chat.provider)
  chat.setModel(items.includes(fallback) ? fallback : items[0])
})

// 切会话 → 重置本地 in-flight + 载入历史（② 也读同一个 store，两边自动同步）
watch(
  () => sessions.curId,
  (sessionId) => void chat.onSessionChanged(sessionId),
  { immediate: true },
)

onMounted(() => {
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
