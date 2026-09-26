<template>
  <Card title="服务管理" padding="none">
    <div class="svcm">
      <EmptyState v-if="!totalCount" title="暂无服务" description="等待 Core 推送 service.* 事件。" />
      <div v-else v-for="(svc, id) in services.services" :key="id" class="svcm__row">
        <span class="dot" :class="dotClass(svc.status)"></span>
        <div class="svcm__info">
          <div class="svcm__name">{{ svc.serviceId }} <span v-if="svc.version" class="svcm__ver">v{{ svc.version }}</span></div>
          <div class="svcm__status">{{ statusLabel(svc.status) }}<span v-if="svc.reason"> · {{ svc.reason }}</span></div>
        </div>
        <div class="svcm__actions">
          <Button v-if="canRestart(svc.status)" size="sm" :loading="busy === svc.serviceId" @click="restart(svc.serviceId)">重启</Button>
          <Button v-if="canStop(svc.status)" size="sm" variant="danger" :loading="busy === svc.serviceId" @click="stop(svc.serviceId)">停用</Button>
          <Button v-if="svc.status === 'stopped'" size="sm" :loading="busy === svc.serviceId" @click="start(svc.serviceId)">启用</Button>
        </div>
      </div>
      <Toast ref="toast" />
    </div>
  </Card>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Toast from '@/components/ui/Toast.vue'
import { useCommand } from '@/core-sdk/useCommand'
import { useServiceStatus } from '@/core-sdk/useServiceStatus'
import type { ServiceLifecycle } from '@/stores/service.store'

const services = useServiceStatus()
const { send } = useCommand()
const toast = ref<{ toast: (message: string, options?: { type?: 'info' | 'success' | 'error' }) => number } | null>(null)
const busy = ref<string | null>(null)

const totalCount = Object.keys(services.services).length

function dotClass(status: ServiceLifecycle): string {
  if (status === 'ready') return 'green'
  if (status === 'starting' || status === 'restarting') return 'yellow'
  if (status === 'failed') return 'red'
  return 'gray'
}
function statusLabel(status: ServiceLifecycle): string {
  return { starting: '启动中', ready: '就绪', restarting: '重启中', failed: '异常', stopped: '已停用' }[status] ?? status
}
function canRestart(status: ServiceLifecycle): boolean {
  return status === 'ready' || status === 'failed' || status === 'restarting'
}
function canStop(status: ServiceLifecycle): boolean {
  return status === 'ready' || status === 'starting' || status === 'restarting'
}

async function run(action: string, id: string, okMsg: string): Promise<void> {
  busy.value = id
  const ok = await send(`service.${action}`, { serviceId: id })
  busy.value = null
  toast.value?.toast(ok ? okMsg : `service.${action} 发送失败`, { type: ok ? 'success' : 'error' })
}
function restart(id: string): Promise<void> { return run('restart', id, `已请求重启 ${id}`) }
function stop(id: string): Promise<void> { return run('stop', id, `已请求停用 ${id}`) }
function start(id: string): Promise<void> { return run('start', id, `已请求启用 ${id}`) }
</script>

<style scoped>
.svcm { display: flex; flex-direction: column; }
.svcm__row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--color-border); }
.svcm__row:last-child { border-bottom: 0; }
.svcm__info { flex: 1; min-width: 0; }
.svcm__name { font-size: var(--text-sm); font-weight: 600; }
.svcm__ver { color: var(--color-text-muted); font-weight: 400; font-size: var(--text-xs); }
.svcm__status { font-size: var(--text-xs); color: var(--color-text-muted); }
.svcm__actions { display: flex; gap: var(--space-1); }
</style>
