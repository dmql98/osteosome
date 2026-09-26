<template>
  <div class="cmd">
    <Card title="命令台" padding="sm">
      <div class="cmd__form">
        <Input v-model="topic" placeholder="topic，如 hello.command" aria-label="命令 topic" />
        <Textarea v-model="payloadText" placeholder="payload（JSON，可空）" aria-label="payload" :rows="3" />
        <div class="cmd__actions">
          <span class="cmd__status" :class="statusClass">{{ statusText }}</span>
          <Button :loading="sending" @click="sendCmd">发送</Button>
        </div>
      </div>
    </Card>

    <Card title="最近事件" padding="none">
      <div class="cmd__events">
        <div v-if="!events.length" class="cmd__none">发送命令后，匹配的事件会显示在这里。</div>
        <div v-for="(e, i) in events" :key="i" class="cmd__event">
          <span class="cmd__event-topic">{{ e.topic }}</span>
          <span class="cmd__event-time">{{ e.time }}</span>
        </div>
      </div>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useCommand } from '@/core-sdk/useCommand'
import { useEventBus } from '@/core-sdk/useEventBus'

const topic = ref('hello.command')
const payloadText = ref('')
const sending = ref(false)
const events = ref<Array<{ topic: string; time: string }>>([])
const { send } = useCommand()

const parsed = computed(() => {
  const raw = payloadText.value.trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
})
const statusText = computed(() => (parsed.value === null ? 'payload 非合法 JSON' : '就绪'))
const statusClass = computed(() => (parsed.value === null ? 'cmd__status--error' : ''))

useEventBus('*', (_payload, topicName) => {
  if (topicName && topicName === topic.value) {
    events.value.unshift({ topic: topicName, time: new Date().toLocaleTimeString() })
    if (events.value.length > 50) events.value.length = 50
  }
})

async function sendCmd(): Promise<void> {
  if (!topic.value.trim() || parsed.value === null) return
  sending.value = true
  const ok = await send(topic.value.trim(), parsed.value)
  sending.value = false
  events.value.unshift({
    topic: ok ? `→ ${topic.value}` : `✕ ${topic.value} (失败)`,
    time: new Date().toLocaleTimeString(),
  })
  if (events.value.length > 50) events.value.length = 50
}
</script>

<style scoped>
.cmd { display: flex; flex-direction: column; gap: var(--space-3); height: 100%; overflow: auto; padding: var(--space-3); }
.cmd__form { display: grid; gap: var(--space-2); }
.cmd__actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); }
.cmd__status { font-size: var(--text-xs); color: var(--color-text-muted); }
.cmd__status--error { color: var(--color-danger); }
.cmd__events { display: flex; flex-direction: column; }
.cmd__none { padding: var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); text-align: center; }
.cmd__event { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--color-border); font-size: var(--text-sm); font-family: var(--font-mono); }
.cmd__event:last-child { border-bottom: 0; }
.cmd__event-topic { flex: 1; }
.cmd__event-time { color: var(--color-text-muted); font-family: var(--font-sans); font-size: var(--text-xs); }
</style>
