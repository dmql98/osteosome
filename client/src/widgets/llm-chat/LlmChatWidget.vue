<template>
  <Card title="LLM 对话" class="llm-chat">
    <div v-if="!list.length" class="llm-chat__no-provider">
      <EmptyState
        icon="🔌"
        title="尚未注册任何 provider"
        description="等待 llm.provider.registered 事件…（deepseek / openrouter / openai）"
      />
    </div>

    <template v-else>
      <div class="llm-chat__provider">
        <Select
          v-model="provider"
          :options="providerOptions"
          aria-label="选择 provider"
          data-testid="llm-chat-provider"
        />
        <Input :model-value="model ?? ''" placeholder="模型（默认）" readonly aria-label="默认模型" class="llm-chat__model" />
      </div>

      <div class="llm-chat__messages" data-testid="llm-chat-messages">
        <template v-for="message in messages" :key="message.key">
          <div
            class="llm-chat__bubble"
            :class="message.role === 'user' ? 'llm-chat__bubble--user' : 'llm-chat__bubble--assistant'"
            :data-testid="`llm-chat-${message.role}`"
          >
            <span v-if="message.role === 'assistant' && message.pending" class="llm-chat__spinner"><Spinner :size="12" /></span>
            {{ message.text }}
          </div>
        </template>
        <div v-if="failed" class="llm-chat__failed" data-testid="llm-chat-failed">{{ failed }}</div>
      </div>

      <form class="llm-chat__composer" @submit.prevent="submit">
        <Textarea
          v-model="draft"
          placeholder="输入消息，Enter 发送"
          :disabled="sending"
          :rows="2"
          auto-grow
          aria-label="消息输入"
          data-testid="llm-chat-input"
        />
        <div class="llm-chat__actions">
          <Button v-if="sending" variant="danger" size="sm" @click="cancel">停止</Button>
          <Button v-else type="submit" size="sm" :disabled="!provider || !draft.trim()" data-testid="llm-chat-send">
            发送
          </Button>
        </div>
      </form>
    </template>
  </Card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Input from '@/components/ui/Input.vue'
import Select from '@/components/ui/Select.vue'
import Spinner from '@/components/ui/Spinner.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useCommand } from '@/core-sdk/useCommand'
import { useEventBus } from '@/core-sdk/useEventBus'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'

interface ChatMessage {
  key: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
}

const { list } = useLlmProviders()
const { send } = useCommand()

const providerOptions = computed(() => list.value.map((p) => ({ label: p.provider, value: p.provider })))
const provider = ref('')
const model = computed(() => list.value.find((p) => p.provider === provider.value)?.defaultModel ?? '')

const draft = ref('')
const sending = ref(false)
const messages = ref<ChatMessage[]>([])
const failed = ref('')
const activeRequestId = ref('')

let messageSeq = 0

// provider 列表初始为空（SSE 未推送前），首个注册到达时自动选中（供 chat 直接可用）
watch(
  list,
  (current) => {
    if (!provider.value && current.length > 0) provider.value = current[0].provider
  },
  { immediate: true },
)

function submit(): void {
  const text = draft.value.trim()
  const chosen = provider.value
  if (!text || !chosen || sending.value) return
  draft.value = ''
  messages.value.push({ key: `user-${++messageSeq}`, role: 'user', text })
  messages.value.push({ key: `assistant-${++messageSeq}`, role: 'assistant', text: '', pending: true })
  const requestId = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`
  activeRequestId.value = requestId
  failed.value = ''
  sending.value = true
  void send('llm.request', {
    requestId,
    provider: chosen,
    model: list.value.find((p) => p.provider === chosen)?.defaultModel,
    messages: [{ role: 'user', content: text }],
  })
}

useEventBus('llm.token.streamed', (payload) => {
  if (!payload || typeof payload !== 'object' || !sending.value) return
  const p = payload as Record<string, unknown>
  if (p.requestId !== activeRequestId.value) return
  const assistant = messages.value[messages.value.length - 1]
  if (!assistant || assistant.role !== 'assistant') return
  if (typeof p.token === 'string') assistant.text += p.token
})

useEventBus('llm.request.finished', (payload) => {
  if (!payload || typeof payload !== 'object') return
  const p = payload as Record<string, unknown>
  if (p.requestId !== activeRequestId.value) return
  const assistant = messages.value[messages.value.length - 1]
  if (assistant) assistant.pending = false
  sending.value = false
  activeRequestId.value = ''
})

useEventBus('llm.request.failed', (payload) => {
  if (!payload || typeof payload !== 'object') return
  const p = payload as Record<string, unknown>
  if (p.requestId !== activeRequestId.value) return
  const error = p.error as { code?: string; message?: string } | undefined
  const code = error?.code ?? ''
  const label: Record<string, string> = {
    unsupported_provider: 'provider 未注册或已下线',
    missing_credential: '缺少 API Key（请在环境变量配置）',
    unauthorized: '认证失败（API Key 无效）',
    rate_limited: '请求过于频繁，请稍后再试',
    server_error: '上游服务错误',
    network: '网络异常，无法连接上游',
    invalid_request: '请求参数无效',
  }
  const assistant = messages.value[messages.value.length - 1]
  if (assistant && assistant.pending) {
    assistant.pending = false
    assistant.text = ''
  }
  failed.value = label[code] ?? error?.message ?? `请求失败（${code}）`
  sending.value = false
  activeRequestId.value = ''
})

function cancel(): void {
  if (activeRequestId.value) void send('llm.cancel', { requestId: activeRequestId.value })
}
</script>

<style scoped>
.llm-chat { display: flex; flex-direction: column; gap: var(--space-3); }
.llm-chat__provider { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(160px, 1.5fr); gap: var(--space-2); }
.llm-chat__model input { font-size: var(--text-sm); color: var(--color-text-muted); }
.llm-chat__messages { display: grid; gap: var(--space-2); min-height: 120px; max-height: 320px; overflow-y: auto; padding: var(--space-2); background: var(--color-surface-1); border-radius: var(--radius-md); }
.llm-chat__bubble { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-sm); white-space: pre-wrap; word-break: break-word; }
.llm-chat__bubble--user { justify-self: end; background: var(--color-accent); color: var(--color-text-inverse); }
.llm-chat__bubble--assistant { justify-self: start; background: var(--color-surface-2); }
.llm-chat__bubble--assistant.llm-chat__bubble--empty { color: var(--color-text-muted); }
.llm-chat__spinner { display: inline-flex; margin-right: var(--space-1); vertical-align: middle; }
.llm-chat__failed { color: var(--color-danger); font-size: var(--text-sm); }
.llm-chat__composer { display: grid; gap: var(--space-2); }
.llm-chat__actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
