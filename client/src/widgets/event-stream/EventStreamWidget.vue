<template>
  <div class="estream">
    <div class="estream__toolbar">
      <Input v-model="filter" placeholder="按 topic 过滤，如 service.*" aria-label="过滤 topic" />
      <Button size="sm" @click="clear">清空</Button>
      <Switch :model-value="paused" @update:model-value="paused = $event" label="暂停" />
    </div>
    <Card title="事件流" padding="none" class="estream__list">
      <div v-if="!shown.length" class="estream__none">等待 Core 事件…（匹配 '' 即全部）</div>
      <div v-for="(e, i) in shown" :key="e.id" class="estream__row" :class="e.kind">
        <span class="estream__time">{{ e.time }}</span>
        <span class="estream__topic">{{ e.topic }}</span>
        <span class="estream__payload">{{ e.summary }}</span>
      </div>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Input from '@/components/ui/Input.vue'
import Switch from '@/components/ui/Switch.vue'
import { useEventBus } from '@/core-sdk/useEventBus'

interface StreamItem {
  id: number
  topic: string
  summary: string
  time: string
  kind: 'default' | 'ready' | 'failed'
}

const filter = ref('')
const paused = ref(false)
const items = ref<StreamItem[]>([])
let counter = 0

function summarize(payload: unknown, topic: string): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload.slice(0, 80)
  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    // 挑几个常见关键字段做摘要
    const parts: string[] = []
    for (const key of ['serviceId', 'requestId', 'status', 'version', 'text', 'echo', 'reason']) {
      if (typeof obj[key] === 'string') parts.push(`${key}=${(obj[key] as string).slice(0, 40)}`)
    }
    return parts.length ? parts.join(' ') : JSON.stringify(payload).slice(0, 80)
  }
  return String(payload).slice(0, 80)
}

function kindFor(topic: string): StreamItem['kind'] {
  if (topic.includes('failed') || topic.includes('error')) return 'failed'
  if (topic.includes('ready') || topic.includes('started')) return 'ready'
  return 'default'
}

useEventBus('*', (payload, topic) => {
  if (paused.value) return
  const t = topic ?? ''
  items.value.unshift({
    id: ++counter,
    topic: t,
    summary: summarize(payload, t),
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    kind: kindFor(t),
  })
  if (items.value.length > 200) items.value.length = 200
})

const shown = computed(() => {
  const q = filter.value.trim()
  if (!q) return items.value
  return items.value.filter((e) => e.topic.includes(q) || e.summary.includes(q))
})

function clear(): void {
  items.value = []
}
</script>

<style scoped>
.estream { display: flex; flex-direction: column; gap: var(--space-2); height: 100%; overflow: hidden; padding: var(--space-3); }
.estream__toolbar { display: flex; align-items: center; gap: var(--space-2); }
.estream__toolbar .ui-input { flex: 1; }
.estream__list { flex: 1; min-height: 0; overflow: auto; }
.estream__none { padding: var(--space-5); color: var(--color-text-muted); font-size: var(--text-sm); text-align: center; }
.estream__row { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); border-bottom: 1px solid var(--color-border); font-size: var(--text-xs); font-family: var(--font-mono); }
.estream__row:last-child { border-bottom: 0; }
.estream__time { color: var(--color-text-muted); flex-shrink: 0; }
.estream__topic { color: var(--color-primary); font-weight: 600; flex-shrink: 0; min-width: 140px; }
.estream__payload { color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.estream__row.ready .estream__topic { color: var(--color-success); }
.estream__row.failed .estream__topic { color: var(--color-danger); }
</style>
