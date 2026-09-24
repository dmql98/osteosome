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
const props = defineProps<{ id: string; widgets?: string[] }>()
const widgets = computed(() => props.widgets ?? [])
function closeWindow(): void { window.close() }
onMounted(() => { sse.ensureConnected() })
</script>

<style scoped>
.panel-host { display: flex; flex-direction: column; height: 100%; background-color: var(--color-surface); }.panel-host__bar { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; background-color: var(--color-surface-2); border-bottom: 1px solid var(--color-border); }.panel-host__id { margin-left: auto; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 400; }.panel-host__bar button { border: 0; background: transparent; color: var(--color-text-muted); cursor: pointer; font-size: 20px; }.panel-host__body { flex: 1; min-height: 0; }
</style>
