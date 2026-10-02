<template>
  <div class="panel-host">
    <header class="panel-host__bar" data-tauri-drag-region>
      <span data-tauri-drag-region>面板</span>
      <span class="panel-host__id" data-tauri-drag-region>{{ id }}</span>
      <WindowControls />
    </header>
    <div class="panel-host__body">
      <PanelContainer :params="{ widgets, title: '' }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import PanelContainer from './PanelContainer.vue'
import WindowControls from '../components/layout/WindowControls.vue'
import { sse } from '../core-sdk/sse'
import { usePluginStore } from '../stores/plugin.store'
const props = defineProps<{ id: string; widgets?: string[] }>()
const widgets = computed(() => props.widgets ?? [])

onMounted(() => {
  sse.ensureConnected()
  void usePluginStore().bootstrap()
})
</script>

<style scoped>
.panel-host { display: flex; flex-direction: column; height: 100%; background-color: var(--color-surface); }.panel-host__bar { display: flex; align-items: center; gap: var(--space-2); height: 32px; padding: 0 0 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; color: var(--color-topbar-text); background: linear-gradient(180deg, var(--color-topbar-bg) 0%, var(--color-topbar-bg-2) 100%); border-bottom: 1px solid var(--color-topbar-border); }.panel-host__id { margin-left: auto; color: var(--color-topbar-text-muted); font-size: var(--text-xs); font-weight: 400; }.panel-host__body { flex: 1; min-height: 0; }
</style>
