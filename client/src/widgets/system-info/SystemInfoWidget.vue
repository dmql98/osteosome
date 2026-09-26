<template>
  <Card title="系统信息" padding="none">
    <div class="sysinfo">
      <div class="sysinfo__row" v-for="(row, i) in rows" :key="i">
        <span class="sysinfo__label">{{ row.label }}</span>
        <span class="sysinfo__value">
          <span v-if="row.dot" class="dot" :class="row.dot"></span>
          {{ row.value }}
        </span>
      </div>
      <EmptyState v-if="!totalCount" class="sysinfo__empty" title="暂无服务" description="等待 Core 推送 service.* 事件。" />
    </div>
  </Card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useServiceStatus } from '@/core-sdk/useServiceStatus'

const services = useServiceStatus()

const readyCount = computed(() => services.readyCount)
const totalCount = computed(() => services.totalCount)
const failedCount = computed(() => Object.values(services.services).filter((s) => s.status === 'failed').length)
const runningCount = computed(() => Object.values(services.services).filter((s) => s.status === 'ready' || s.status === 'starting' || s.status === 'restarting').length)

const rows = computed(() => [
  { label: '版本', value: '0.0.0-dev' },
  { label: '服务', value: `${readyCount.value} / ${totalCount.value} 就绪`, dot: readyCount.value === totalCount.value && totalCount.value > 0 ? 'green' : 'yellow' },
  { label: '运行中', value: `${runningCount.value} 个` },
  { label: '异常', value: `${failedCount.value} 个`, dot: failedCount.value > 0 ? 'red' : 'gray' },
  { label: '连接', value: '本地 SSE' },
])
</script>

<style scoped>
.sysinfo { display: flex; flex-direction: column; }
.sysinfo__row { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--color-border); font-size: var(--text-sm); }
.sysinfo__row:last-child { border-bottom: 0; }
.sysinfo__label { color: var(--color-text-muted); }
.sysinfo__value { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.sysinfo__empty { padding: var(--space-4); }
</style>
