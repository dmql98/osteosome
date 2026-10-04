<template>
  <Teleport to="body">
    <div v-if="open" class="ui-modal" role="presentation" @mousedown.self="onMaskClick">
      <section ref="dialog" class="ui-modal__dialog" role="dialog" aria-modal="true" :aria-label="title" @keydown.esc="close">
        <header v-if="title || $slots.header || closable" class="ui-modal__header">
          <slot name="header"><h2 v-if="title" class="ui-modal__title">{{ title }}</h2></slot>
          <button v-if="closable" class="ui-modal__close" type="button" aria-label="关闭" @click="close">×</button>
        </header>
        <div class="ui-modal__body"><slot /></div>
        <footer v-if="$slots.footer" class="ui-modal__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ open: boolean; title?: string; width?: string | number; closable?: boolean; maskClosable?: boolean }>(), {
  title: undefined, width: 480, closable: true, maskClosable: true,
})
const emit = defineEmits<{ 'update:open': [value: boolean]; close: [] }>()
const dialog = ref<HTMLElement | null>(null)
let previous: HTMLElement | null = null

function close(): void { emit('update:open', false); emit('close') }
function onMaskClick(event: MouseEvent): void { if (props.maskClosable && event.target === event.currentTarget) close() }
function trap(event: KeyboardEvent): void {
  if (!props.open || !dialog.value) return
  if (event.key === 'Escape') { event.preventDefault(); close(); return }
  if (event.key !== 'Tab') return
  const focusable = dialog.value.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')
  if (!focusable.length) return
  const first = focusable[0]; const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(() => props.open, async (value) => {
  document.removeEventListener('keydown', trap)
  if (value) { previous = document.activeElement as HTMLElement | null; document.addEventListener('keydown', trap); await nextTick(); dialog.value?.querySelector<HTMLElement>('button, input, select, textarea, [href], [tabindex]')?.focus() }
  else previous?.focus()
})
onBeforeUnmount(() => document.removeEventListener('keydown', trap))
</script>

<style scoped>
.ui-modal { position: fixed; inset: 0; z-index: var(--z-modal); display: grid; place-items: center; background: rgba(0, 0, 0, .45); }
.ui-modal__dialog { width: min(calc(100vw - 32px), v-bind('typeof width === "number" ? `${width}px` : width')); max-height: calc(100vh - 32px); overflow: auto; background: var(--color-surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); }
.ui-modal__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); }
.ui-modal__title { font-size: var(--text-lg); }
.ui-modal__close { border: 0; background: transparent; color: var(--color-text-muted); font-size: 22px; cursor: pointer; }
.ui-modal__body { padding: var(--space-5); }
.ui-modal__footer { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-5); border-top: 1px solid var(--color-border); }
</style>
