<template>
  <Card title="对话" class="chat-timeline">
    <div class="chat-timeline__messages" data-testid="timeline-messages">
      <EmptyState
        v-if="!rowsView.length"
        icon="💬"
        title="这个会话还没有消息"
        description="在下方输入框发问，会话会自动保存历史。"
      />

      <template v-for="row in rowsView" :key="row.key">
        <!-- user / assistant 气泡 -->
        <div
          class="chat-timeline__bubble"
          :class="row.role === 'user' ? 'chat-timeline__bubble--user' : 'chat-timeline__bubble--assistant'"
          :data-testid="`timeline-${row.role}`"
        >
          <span v-if="row.pending" class="chat-timeline__spinner"><Spinner :size="12" /></span>
          {{ row.text }}
          <!-- S4：流式尾光标（本轮还在跑且正文已开始） -->
          <span v-if="showCaret(row)" class="chat-timeline__caret" data-testid="timeline-caret" />
        </div>

        <!-- S4：折叠思考块。与正文分开渲染 —— 这是「思维链不进正文」的可见证据 -->
        <details v-if="row.reasoning" class="chat-timeline__thinking" :data-testid="`timeline-thinking-${row.key}`">
          <summary class="chat-timeline__thinking-head">
            <span class="chat-timeline__thinking-label">💭 思考过程</span>
            <span class="chat-timeline__thinking-count">{{ row.reasoning.length }} 字</span>
          </summary>
          <pre class="chat-timeline__thinking-body" data-testid="timeline-thinking-body">{{ row.reasoning }}</pre>
        </details>

        <!-- 工具卡：执行中 → ✓ / ✗ -->
        <div
          v-for="call in row.toolCalls ?? []"
          :key="call.id"
          class="chat-timeline__tool"
          :class="{
            'chat-timeline__tool--failed': call.ok === false,
            'chat-timeline__tool--running': call.ok === undefined,
          }"
          :data-testid="`timeline-tool-${call.name}`"
        >
          <span class="chat-timeline__tool-name">🔧 {{ call.name }}</span>
          <span class="chat-timeline__tool-args">{{ call.arguments }}</span>
          <span v-if="call.ok === undefined" class="chat-timeline__tool-state">执行中…</span>
          <span v-else-if="call.ok" class="chat-timeline__tool-state chat-timeline__tool-state--ok">
            ✓ {{ call.summary }}
          </span>
          <span v-else class="chat-timeline__tool-state chat-timeline__tool-state--err">✗ {{ call.summary }}</span>
        </div>

        <!-- S4：停因与用量（S4 前这两个字段被丢，刷新就没了） -->
        <div
          v-if="row.role === 'assistant' && !row.pending && (row.finishReason || row.usage)"
          class="chat-timeline__meta"
          data-testid="timeline-meta"
        >
          <span v-if="finishLabel(row.finishReason)" class="chat-timeline__meta-item">
            {{ finishLabel(row.finishReason) }}
          </span>
          <span v-if="row.usage" class="chat-timeline__meta-item mono">
            ↑{{ row.usage.promptTokens }} ↓{{ row.usage.completionTokens }}
          </span>
        </div>
      </template>

      <!-- 错误内联：不清空上文，就在末尾 -->
      <div v-if="failed" class="chat-timeline__failed" data-testid="timeline-failed">{{ failed }}</div>
    </div>
  </Card>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Card } from '@osteosome/ui'
import { EmptyState } from '@osteosome/ui'
import { Spinner } from '@osteosome/ui'
import { useChatStore, type ChatRow } from '@/stores/chat.store'

/**
 * ② 对话时间线 —— **纯展示**。
 *
 * 不发任何命令、不改任何状态：所有数据与动作都在 `chat.store` 里。这样它可以被单独嵌到
 * 任何面板（只读的消息投影），而 ③ composer 不需要知道它存在。
 */
const chat = useChatStore()

const rowsView = computed<ChatRow[]>(() => chat.rowsView)
const failed = computed(() => chat.failed)

/** 尾光标：只在「本轮在跑 + 这一行正在流式 + 已有正文」时显示 */
function showCaret(row: ChatRow): boolean {
  return Boolean(chat.sending && row.pending && row.text.length > 0)
}

/** finishReason → 人话（只对用户有意义的那几个取值翻译） */
const FINISH_LABEL: Record<string, string> = {
  stop: '正常结束',
  length: '达到长度上限',
  content_filter: '被内容过滤',
  tool_calls: '工具调用',
  error: '出错结束',
}
function finishLabel(reason?: string): string {
  return reason ? (FINISH_LABEL[reason] ?? reason) : ''
}

onMounted(() => {
  chat.bindEvents()
})
</script>

<style scoped>
.chat-timeline { display: flex; flex-direction: column; gap: var(--space-3); }
.chat-timeline__messages {
  display: grid; gap: var(--space-2); align-content: start;
  min-height: 120px; max-height: 420px; overflow-y: auto;
  padding: var(--space-2); background: var(--color-surface-1); border-radius: var(--radius-md);
}
.chat-timeline__bubble {
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-md);
  font-size: var(--text-sm); white-space: pre-wrap; word-break: break-word;
}
.chat-timeline__bubble--user { justify-self: end; background: var(--color-accent); color: var(--color-text-inverse); }
.chat-timeline__bubble--assistant { justify-self: start; background: var(--color-surface-2); }
.chat-timeline__spinner { display: inline-flex; margin-right: var(--space-1); vertical-align: middle; }
.chat-timeline__caret {
  display: inline-block; width: 6px; height: 1em; margin-left: 2px; vertical-align: text-bottom;
  background: var(--color-accent); animation: chat-timeline-blink 1s steps(2, start) infinite;
}
@keyframes chat-timeline-blink { to { visibility: hidden; } }

/* 折叠思考块 */
.chat-timeline__thinking {
  justify-self: start; border: 1px solid var(--color-border); border-left: 3px solid var(--color-warning);
  border-radius: var(--radius-sm); background: var(--color-surface-1); font-size: var(--text-xs);
}
.chat-timeline__thinking-head {
  display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3);
  cursor: pointer; color: var(--color-text-muted); list-style: none;
}
.chat-timeline__thinking-head::-webkit-details-marker { display: none; }
.chat-timeline__thinking-label { color: var(--color-text); }
.chat-timeline__thinking-count { margin-left: auto; }
.chat-timeline__thinking-body {
  margin: 0; padding: 0 var(--space-3) var(--space-2);
  white-space: pre-wrap; word-break: break-word; color: var(--color-text-muted);
}

.chat-timeline__tool {
  display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap;
  padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent); border-radius: var(--radius-sm);
  font-size: var(--text-xs); background: var(--color-surface-1);
}
.chat-timeline__tool--failed { border-left-color: var(--color-danger); }
.chat-timeline__tool--running { border-left-color: var(--color-warning); }
.chat-timeline__tool-name { font-weight: 600; color: var(--color-text); }
.chat-timeline__tool-args { color: var(--color-text-muted); font-family: var(--font-mono, monospace); word-break: break-all; }
.chat-timeline__tool-state { color: var(--color-text-muted); }
.chat-timeline__tool-state--ok { color: var(--color-success); }
.chat-timeline__tool-state--err { color: var(--color-danger); }

.chat-timeline__meta { display: flex; gap: var(--space-3); font-size: var(--text-xs); color: var(--color-text-muted); }
.chat-timeline__failed { color: var(--color-danger); font-size: var(--text-sm); }
</style>
