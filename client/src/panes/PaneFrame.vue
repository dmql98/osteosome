<template>
  <section class="pane-frame">
    <header class="pane-frame__bar">
      <span class="pane-frame__drag" aria-hidden="true">⠿</span>
      <span class="pane-frame__title">{{ definition.title }}</span>
      <div class="pane-frame__actions">
        <button type="button" aria-label="重置布局" title="重置布局" @click="emit('reset')">⇱</button>
        <button v-if="definition.windowable !== false" type="button" aria-label="拉出独立窗" title="拉出独立窗" @click="emit('detach')">⤢</button>
        <button type="button" aria-label="关闭 Pane" title="关闭 Pane" @click="requestClose">×</button>
      </div>
    </header>
    <div class="pane-frame__body"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import type { PaneDefinition } from './types'
const props = defineProps<{ definition: PaneDefinition; api?: { close?: () => void } }>()
const emit = defineEmits<{ close: []; reset: []; detach: [] }>()
async function requestClose(): Promise<void> {
  if (props.definition.onBeforeClose && !(await props.definition.onBeforeClose())) return
  emit('close')
}
</script>

<style scoped>
.pane-frame { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--color-surface); }.pane-frame__bar { display: flex; align-items: center; gap: var(--space-2); height: 32px; padding: 0 var(--space-2) 0 var(--space-3); background: var(--color-surface-2); border-bottom: 1px solid var(--color-border); user-select: none; }.pane-frame__drag { color: var(--color-text-muted); cursor: grab; }.pane-frame__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 600; }.pane-frame__actions { display: flex; gap: 2px; }.pane-frame__actions button { width: 24px; height: 24px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; }.pane-frame__actions button:hover { background: var(--color-surface-3); color: var(--color-text); }.pane-frame__body { flex: 1; min-height: 0; overflow: auto; }
</style>
