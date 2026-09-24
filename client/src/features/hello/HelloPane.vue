<template>
  <div class="hello-pane">
    <Toast ref="toast" />
    <Card title="服务状态" padding="none">
      <Table v-if="rows.length" :columns="columns" :rows="rows" row-key="serviceId" />
      <EmptyState v-else title="暂无服务状态" description="等待 Core 推送 service.* 事件。" />
    </Card>
    <div class="hello-pane__actions"><Button :loading="sending" @click="sendHello">发送 hello.command</Button></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Table from '@/components/ui/Table.vue'
import Toast from '@/components/ui/Toast.vue'
import { useCommand } from '@/core-sdk/useCommand'
import { useEventBus } from '@/core-sdk/useEventBus'
import { useServiceStatus } from '@/core-sdk/useServiceStatus'

const services = useServiceStatus()
const { send } = useCommand()
const toast = ref<{ toast: (message: string, options?: { type?: 'info' | 'success' | 'error' }) => number } | null>(null)
const requestId = `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
const sending = ref(false)
const rows = computed(() => Object.values(services.services).map((service) => ({
  serviceId: service.serviceId,
  status: service.status,
  lastHeartbeat: service.lastSeenAt ? new Date(service.lastSeenAt).toLocaleTimeString() : '—',
})))
const columns = [
  { key: 'serviceId', label: 'serviceId' },
  { key: 'status', label: 'status' },
  { key: 'lastHeartbeat', label: '最后心跳' },
]

useEventBus('hello.command.executed', (payload) => {
  if (payload && typeof payload === 'object' && 'echo' in payload) toast.value?.toast(`Echo: ${String(payload.echo)}`, { type: 'success' })
})
useEventBus('hello.command.failed', () => toast.value?.toast('hello.command 执行失败', { type: 'error' }))

async function sendHello(): Promise<void> {
  sending.value = true
  const ok = await send('hello.command', { requestId, text: 'hi' })
  sending.value = false
  if (!ok) toast.value?.toast('命令发送失败', { type: 'error' })
}
</script>

<style scoped>
.hello-pane { display: grid; gap: var(--space-4); height: 100%; padding: var(--space-4); background: var(--color-surface-2); }.hello-pane__actions { display: flex; justify-content: flex-end; }
</style>
