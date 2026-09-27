<template>
  <div class="plugin-win">
    <header class="plugin-win__bar">
      <span class="plugin-win__title">🧩 插件管理</span>
      <span class="plugin-win__spacer"></span>
      <Button size="sm" variant="ghost" @click="refresh">刷新</Button>
      <IconButton icon="×" size="sm" label="关闭窗口" @click="closeWindow" />
    </header>
    <div class="plugin-win__body">
      <EmptyState
        v-if="!totalCount"
        icon="📦"
        title="还没有插件"
        description="等待 Core 启动并推送 service.* 事件。"
      />
      <div v-else class="plugin-win__list">
        <div class="plugin-win__section-title">已安装 ({{ totalCount }})</div>
        <div v-for="svc in rows" :key="svc.serviceId" class="plugin-card">
          <div class="plugin-card__icon">🔌</div>
          <div class="plugin-card__info">
            <div class="plugin-card__name">
              {{ svc.name }}
              <span v-if="svc.version" class="plugin-card__badge">v{{ svc.version }}</span>
            </div>
            <div class="plugin-card__status">
              <span class="dot" :class="dotClass(svc.status)"></span>{{ statusLabel(svc.status) }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import { useServiceStatus } from '@/core-sdk/useServiceStatus'
import type { ServiceLifecycle } from '@/stores/service.store'
import { isTauri, closeCurrentWindowViaTauri } from '@/tauri/plugin-window'

const services = useServiceStatus()

const totalCount = computed(() => Object.keys(services.services).length)

const rows = computed(() =>
  Object.values(services.services)
    .map((svc) => ({
      serviceId: svc.serviceId,
      name: svc.serviceId,
      version: svc.version,
      status: svc.status,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
)

function dotClass(status: ServiceLifecycle): string {
  if (status === 'ready') return 'green'
  if (status === 'starting' || status === 'restarting') return 'yellow'
  if (status === 'failed') return 'red'
  return 'gray'
}

function statusLabel(status: ServiceLifecycle): string {
  return { starting: '启动中', ready: '运行中', restarting: '重启中', failed: '异常', stopped: '已停用' }[status] ?? status
}

function refresh(): void {
  void fetch('/health')
    .then(async (response) => {
      if (!response.ok) return
      const health = (await response.json()) as { services?: Array<{ id?: string; status?: string; version?: string }> }
      for (const item of health.services ?? []) {
        if (item.id && item.status) {
          services.setStatus(item.status as Parameters<typeof services.setStatus>[0], { serviceId: item.id, version: item.version })
        }
      }
    })
    .catch(() => undefined)
}

async function closeWindow(): Promise<void> {
  if (isTauri()) await closeCurrentWindowViaTauri()
  else window.close()
}

onMounted(refresh)
</script>

<style scoped>
.plugin-win { display: flex; flex-direction: column; height: 100%; background: var(--color-surface); }
.plugin-win__bar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
.plugin-win__title { font-weight: 700; font-size: var(--text-md); }
.plugin-win__spacer { flex: 1; }
.plugin-win__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); }
.plugin-win__list { display: flex; flex-direction: column; gap: var(--space-3); }
.plugin-win__section-title { font-size: var(--text-sm); font-weight: 700; color: var(--color-text-muted); }
.plugin-card { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.plugin-card:hover { border-color: var(--color-primary); }
.plugin-card__icon { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--color-surface-2); display: grid; place-items: center; font-size: 20px; flex: none; }
.plugin-card__info { flex: 1; min-width: 0; }
.plugin-card__name { font-weight: 600; font-size: var(--text-sm); display: flex; align-items: center; gap: 6px; }
.plugin-card__badge { font-size: var(--text-xs); color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: var(--radius-full); padding: 0 6px; }
.plugin-card__status { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
</style>
