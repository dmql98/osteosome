<template>
  <div class="pane-host">
    <header class="pane-host__bar"><span>{{ definition?.title ?? id }}</span><span class="pane-host__id">{{ id }}</span><button type="button" aria-label="关闭窗口" @click="closeWindow">×</button></header>
    <div class="pane-host__body">
      <PaneView v-if="definition" :params="{ paneId: id }" />
      <PaneError v-else title="Pane 不存在" detail="该 Pane 未注册到当前工作台。" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { getPane } from './registry'
import PaneError from './PaneError.vue'
import PaneView from './PaneView.vue'
import { sse } from '../core-sdk/sse'
const props = defineProps<{ id: string }>()
const definition = computed(() => getPane(props.id))
function closeWindow(): void { window.close() }
onMounted(() => { sse.ensureConnected() })
</script>

<style scoped>
.pane-host { display: flex; flex-direction: column; height: 100%; background-color: var(--color-surface); }.pane-host__bar { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; background-color: var(--color-surface-2); border-bottom: 1px solid var(--color-border); }.pane-host__id { margin-left: auto; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 400; }.pane-host__bar button { border: 0; background: transparent; color: var(--color-text-muted); cursor: pointer; font-size: 20px; }.pane-host__body { flex: 1; min-height: 0; }
</style>
