<template>
  <Teleport to="body">
    <div v-if="open" class="ui-drawer" :class="`ui-drawer--${side}`" @mousedown.self="onMaskClick">
      <section ref="panel" class="ui-drawer__panel" role="dialog" aria-modal="true" :aria-label="title" @keydown.esc="close">
        <header class="ui-drawer__header"><h2 v-if="title">{{ title }}</h2><slot name="header" /><button type="button" aria-label="关闭" @click="close">×</button></header>
        <div class="ui-drawer__body"><slot /></div>
        <footer v-if="$slots.footer" class="ui-drawer__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
const props = withDefaults(defineProps<{ open: boolean; title?: string; side: 'left' | 'right'; size?: string | number }>(), { title: undefined, size: 360 })
const emit = defineEmits<{ 'update:open': [value: boolean]; close: [] }>()
const panel = ref<HTMLElement | null>(null)
function close(): void { emit('update:open', false); emit('close') }
function onMaskClick(event: MouseEvent): void { if (event.target === event.currentTarget) close() }
function onKeydown(event: KeyboardEvent): void { if (props.open && event.key === 'Escape') { event.preventDefault(); close() } }
watch(() => props.open, async (value) => { document.removeEventListener('keydown', onKeydown); if (value) { document.addEventListener('keydown', onKeydown); await nextTick(); panel.value?.querySelector<HTMLElement>('button, input, select, textarea, [href], [tabindex]')?.focus() } })
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.ui-drawer { position: fixed; inset: 0; z-index: var(--z-drawer); background: rgba(0, 0, 0, .35); }
.ui-drawer--left { display: flex; justify-content: flex-start; }.ui-drawer--right { display: flex; justify-content: flex-end; }
.ui-drawer__panel { width: v-bind('typeof size === "number" ? `${size}px` : size'); height: 100%; background: var(--color-surface); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; }
.ui-drawer__header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); }.ui-drawer__header h2 { flex: 1; font-size: var(--text-lg); }.ui-drawer__header button { border: 0; background: transparent; font-size: 22px; cursor: pointer; }.ui-drawer__body { flex: 1; overflow: auto; padding: var(--space-5); }.ui-drawer__footer { padding: var(--space-3) var(--space-5); border-top: 1px solid var(--color-border); }
</style>
