<template>
  <div class="panel-host">
    <header class="panel-host__bar"><span>面板</span><span class="panel-host__id">{{ id }}</span><button type="button" aria-label="关闭窗口" @click="closeWindow">×</button></header>
    <div class="panel-host__body">
      <PanelContainer :params="{ widgets, title: '' }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import PanelContainer from './PanelContainer.vue'
import { sse } from '../core-sdk/sse'
import { usePluginStore } from '../stores/plugin.store'
import { closeCurrentWindow } from '../tauri/plugin-window'
const props = defineProps<{ id: string; widgets?: string[] }>()
const widgets = computed(() => props.widgets ?? [])

/** 关闭独立窗：Tauri 走原生 close（壳在 on_window_event 里广播恢复），浏览器由主窗 beforeunload 兜底。 */
function closeWindow(): void {
  void closeCurrentWindow()
}

onMounted(() => {
  sse.ensureConnected()
  void usePluginStore().bootstrap()
})
</script>

<style scoped>
.panel-host { display: flex; flex-direction: column; height: 100%; background-color: var(--color-surface); }.panel-host__bar { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; color: var(--color-topbar-text); background: linear-gradient(180deg, var(--color-topbar-bg) 0%, var(--color-topbar-bg-2) 100%); border-bottom: 1px solid var(--color-topbar-border); }.panel-host__id { margin-left: auto; color: var(--color-topbar-text-muted); font-size: var(--text-xs); font-weight: 400; }.panel-host__bar button { border: 0; background: transparent; color: var(--color-topbar-text-muted); cursor: pointer; font-size: 20px; line-height: 1; border-radius: var(--radius-sm); }.panel-host__bar button:hover { background: var(--color-topbar-overlay-strong); color: var(--color-topbar-text); }.panel-host__body { flex: 1; min-height: 0; }
</style>
