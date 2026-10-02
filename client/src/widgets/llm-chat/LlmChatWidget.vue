<template>
  <Card title="LLM 对话" class="llm-chat">
    <div v-if="!providerOptions.length" class="llm-chat__no-provider">
      <EmptyState
        icon="🔌"
        title="尚未注册任何 provider"
        description="等待 llm.provider.registered 事件…（deepseek / openrouter / openai）"
      />
    </div>

    <template v-else>
      <div class="llm-chat__params">
        <Select
          :model-value="provider"
          :options="providerOptions"
          aria-label="选择 provider"
          data-testid="llm-chat-provider"
          @update:model-value="selectProvider"
        />
        <Select
          :model-value="model"
          :options="modelOptions"
          aria-label="选择模型"
          data-testid="llm-chat-model"
          @update:model-value="onSelectModel"
        />
        <span
          v-if="catalogKind === 'static'"
          class="llm-chat__badge"
          title="未能从服务商拉取模型列表，显示内置列表"
          data-testid="llm-chat-static-badge"
        >
          静态
        </span>
        <Select
          :model-value="thinking"
          :options="thinkingOptions"
          aria-label="思考强度"
          data-testid="llm-chat-thinking"
          @update:model-value="onSelectThinking"
        />
      </div>

      <div class="llm-chat__messages" data-testid="llm-chat-messages">
        <EmptyState
          v-if="!rowsView.length"
          icon="💬"
          title="这个会话还没有消息"
          description="在下方输入框发问，会话会自动保存历史。"
        />
        <template v-for="row in rowsView" :key="row.key">
          <div
            class="llm-chat__bubble"
            :class="row.role === 'user' ? 'llm-chat__bubble--user' : 'llm-chat__bubble--assistant'"
            :data-testid="`llm-chat-${row.role}`"
          >
            <span v-if="row.pending" class="llm-chat__spinner"><Spinner :size="12" /></span>
            {{ row.text }}
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
          <Button v-else type="submit" size="sm" :disabled="!canSend" data-testid="llm-chat-send">发送</Button>
        </div>
      </form>
    </template>
  </Card>
  <Toast ref="toast" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ThinkingEffort } from '@osteosome/shared'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Select from '@/components/ui/Select.vue'
import Spinner from '@/components/ui/Spinner.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Toast from '@/components/ui/Toast.vue'
import { useCommand } from '@/core-sdk/useCommand'
import { useEventBus } from '@/core-sdk/useEventBus'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { useModelCatalog } from '@/core-sdk/useModelCatalog'
import { useSessionStore } from '@/stores/session.store'

interface ChatRow {
  key: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
}

const { list } = useLlmProviders()
const { send } = useCommand()
const sessions = useSessionStore()
const { models: catalogModels, catalog: catalogKind, load: loadCatalog } = useModelCatalog()
const toast = ref<{ toast: (message: string, options?: { type?: 'info' | 'success' | 'error' }) => number } | null>(null)

const providerOptions = computed(() => list.value.map((p) => ({ label: p.provider, value: p.provider })))

/** provider 的声明默认模型（目录未到达时的兜底，也是目录不含它时的优先回落） */
function defaultModelOf(target: string): string {
  return list.value.find((p) => p.provider === target)?.defaultModel ?? ''
}

/**
 * 模型下拉：目录到达前只有「声明默认模型」一项（仍可真发出去），
 * 目录到达后取全量；若当前模型不在目录里，优先回落到声明默认模型，否则取第一项。
 */
const modelOptions = computed(() => {
  const items = catalogModels.value.length > 0 ? catalogModels.value : model.value ? [model.value] : []
  return items.map((m) => ({ label: m, value: m }))
})

const thinkingOptions = [
  { label: '思考：关', value: 'off' },
  { label: '思考：低', value: 'low' },
  { label: '思考：中', value: 'medium' },
  { label: '思考：高', value: 'high' },
]

const provider = ref('')
const model = ref('')
const thinking = ref<ThinkingEffort>('off')

/** 切 provider：模型回落到该家的声明默认模型，并拉它的模型目录（能力位：目录由 provider 自己回答） */
async function selectProvider(value: string | number): Promise<void> {
  provider.value = String(value)
  model.value = defaultModelOf(provider.value)
  await loadCatalog(provider.value)
}

function onSelectModel(value: string | number): void {
  model.value = String(value)
}

function onSelectThinking(value: string | number): void {
  const next = String(value)
  if (next === 'off' || next === 'low' || next === 'medium' || next === 'high') thinking.value = next
}

const draft = ref('')
const sending = ref(false)
const failed = ref('')
/** 在途 run 的 A（loop.run 的 requestId）；前端只见 A */
const activeA = ref('')
/** 本地 in-flight 累积（虚拟 key，assistant 消息落库后由 message.appended 换成服务端 id） */
const rows = ref<ChatRow[]>([])

watch(
  list,
  (current) => {
    if (!provider.value && current.length > 0) void selectProvider(current[0].provider)
  },
  { immediate: true },
)

/** 目录到达 → 校正当前模型选择（不在目录里才动） */
watch(catalogModels, (items) => {
  if (items.length === 0 || items.includes(model.value)) return
  const fallback = defaultModelOf(provider.value)
  model.value = items.includes(fallback) ? fallback : items[0]
})

/** 历史消息（当前会话）→ rows；in-flight 消息始终挂在末尾 */
const rowsView = computed<ChatRow[]>(() => {
  const history = sessions.messages.map((m) => ({ key: m.id, role: m.role === 'user' ? ('user' as const) : ('assistant' as const), text: m.content }))
  return [...history, ...rows.value]
})

const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value)

/** 切会话 / 首次进入：载入历史（session.get）+ 重置本地 in-flight */
watch(
  () => sessions.curId,
  (sessionId) => {
    rows.value = []
    failed.value = ''
    sending.value = false
    activeA.value = ''
    if (sessionId) void loadHistory(sessionId)
  },
)

async function loadHistory(sessionId: string): Promise<void> {
  await send('session.get', { requestId: `get-${Date.now()}`, sessionId })
}

/** session.get.result → 回填消息缓存（不存在 → 回退最近会话） */
useEventBus('session.get.result', (payload) => {
  const p = payload as { session?: { meta?: { id: string }; messages?: unknown[] } | null }
  if (!p?.session) {
    // 会话为空/已删 → 回退最近会话（P3 §0.2）
    const fallback = sessions.recent
    if (fallback && fallback.id !== sessions.curId) sessions.select(fallback.id)
    return
  }
  sessions.messages = (p.session.messages ?? []) as never
})

async function submit(): Promise<void> {
  const text = draft.value.trim()
  if (!text || sending.value) return
  draft.value = ''
  failed.value = ''

  // 会话不存在 → 先建（P3 §0.2：会话创建是前端职责）
  if (!sessions.curId) {
    const requestId = await sessions.create()
    if (!requestId) {
      failed.value = '创建会话失败，请重试'
      return
    }
  }
  const sessionId = sessions.curId || sessions.recent?.id || ''
  if (!sessionId) {
    failed.value = '没有可用会话'
    return
  }
  sessions.select(sessionId)

  const a = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
  activeA.value = a
  sending.value = true
  // 本地 in-flight：user 立即可见 + assistant 累积位（P3 §3.4 虚拟 id 方案）
  rows.value = [
    { key: `local-user-${a}`, role: 'user', text },
    { key: `in-flight-${a}`, role: 'assistant', text: '', pending: true },
  ]
  // P4 WS-2：provider / model / thinking 真正进请求（缺省不下发 → 后端回落 env/模型默认）
  void send('loop.run', {
    requestId: a,
    sessionId,
    text,
    ...(provider.value ? { provider: provider.value } : {}),
    ...(model.value ? { model: model.value } : {}),
    ...(thinking.value !== 'off' ? { thinking: thinking.value } : {}),
  })
}

/** loop.token.streamed（A）→ 累积到本地 in-flight */
useEventBus('loop.token.streamed', (payload) => {
  if (!payload || typeof payload !== 'object' || !sending.value) return
  const p = payload as Record<string, unknown>
  if (p.requestId !== activeA.value) return
  const target = rows.value.find((r) => r.key === `in-flight-${activeA.value}`)
  if (target && typeof p.token === 'string') target.text += p.token
})

/** message.appended（当前会话 assistant）→ in-flight 换服务端 id（视图 id 切换，不重放 content） */
useEventBus('message.appended', (payload) => {
  const p = payload as { sessionId?: string; message?: { id?: string; role?: string; content?: string } }
  if (!p?.sessionId || p.sessionId !== sessions.curId || p.message?.role !== 'assistant') return
  const inFlightKey = `in-flight-${activeA.value}`
  const target = rows.value.find((r) => r.key === inFlightKey)
  if (target) {
    // 视图 id 切换：虚拟 key → 服务端 messageId（content 不重放）
    target.key = p.message.id ?? target.key
    target.pending = false
  }
})

/** loop.state.changed → Spinner 收起 / 输入恢复 */
useEventBus('loop.state.changed', (payload) => {
  const p = payload as { requestId?: string; state?: string }
  if (!p?.requestId || p.requestId !== activeA.value) return
  if (p.state === 'idle') {
    sending.value = false
    // 保留 in-flight 内容（已由 message.appended 换成服务端 id）
  }
})

/** loop.run.failed → 错误占位，不留幽灵 assistant */
useEventBus('loop.run.failed', (payload) => {
  if (!payload || typeof payload !== 'object') return
  const p = payload as { requestId?: string; error?: { code?: string; message?: string } }
  if (p.requestId !== activeA.value) return
  const code = p.error?.code ?? ''
  const label: Record<string, string> = {
    unsupported_provider: 'provider 未注册或已下线',
    missing_credential: '缺少 API Key（请在环境变量配置）',
    unauthorized: '认证失败（API Key 无效）',
    rate_limited: '请求过于频繁，请稍后再试',
    server_error: '上游服务错误',
    network: '网络异常，无法连接上游',
    invalid_request: '请求参数无效',
    busy: '上一轮还在跑，请稍候',
  }
  // 移除空的 in-flight assistant（不留幽灵）
  rows.value = rows.value.filter((r) => r.key !== `in-flight-${activeA.value}` || r.text !== '')
  failed.value = label[code] ?? p.error?.message ?? `请求失败（${code}）`
  sending.value = false
  activeA.value = ''
})

/** loop.run.cancelled → 成功路径，收尾（不留半截 assistant） */
useEventBus('loop.run.cancelled', (payload) => {
  const p = payload as { requestId?: string }
  if (p?.requestId !== activeA.value) return
  rows.value = rows.value.filter((r) => r.key !== `in-flight-${activeA.value}`)
  sending.value = false
  activeA.value = ''
})

/** loop 崩溃恢复（P3 §0.2）：清 in-flight + Toast「服务重连中」 */
useEventBus('service.failed', (payload) => {
  const p = payload as { serviceId?: string }
  if (p?.serviceId !== 'loop') return
  rows.value = rows.value.filter((r) => !r.pending)
  sending.value = false
  activeA.value = ''
  toast.value?.toast('loop 服务异常，正在重连', { type: 'error' })
})

function cancel(): void {
  if (activeA.value) void send('loop.cancel', { requestId: activeA.value })
}
</script>

<style scoped>
.llm-chat { display: flex; flex-direction: column; gap: var(--space-3); }
.llm-chat__params { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.llm-chat__badge { font-size: var(--text-xs); color: var(--color-warning); border: 1px solid var(--color-warning); border-radius: var(--radius-sm); padding: 1px var(--space-2); white-space: nowrap; }
.llm-chat__messages { display: grid; gap: var(--space-2); min-height: 120px; max-height: 320px; overflow-y: auto; padding: var(--space-2); background: var(--color-surface-1); border-radius: var(--radius-md); }
.llm-chat__bubble { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-sm); white-space: pre-wrap; word-break: break-word; }
.llm-chat__bubble--user { justify-self: end; background: var(--color-accent); color: var(--color-text-inverse); }
.llm-chat__bubble--assistant { justify-self: start; background: var(--color-surface-2); }
.llm-chat__spinner { display: inline-flex; margin-right: var(--space-1); vertical-align: middle; }
.llm-chat__failed { color: var(--color-danger); font-size: var(--text-sm); }
.llm-chat__composer { display: grid; gap: var(--space-2); }
.llm-chat__actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
