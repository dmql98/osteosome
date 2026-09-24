<template><div class="split-pane" :class="`split-pane--${direction}`"><div class="split-pane__pane" :style="paneStyle"><slot name="left" /></div><div class="split-pane__divider" role="separator" :aria-orientation="direction === 'horizontal' ? 'vertical' : 'horizontal'" tabindex="0" @keydown.left.prevent="nudge(-0.05)" @keydown.right.prevent="nudge(0.05)" @mousedown="startDrag" /><div class="split-pane__pane" :style="secondStyle"><slot name="right" /></div></div></template>

<script setup lang="ts">
import { computed, ref } from 'vue'
const props = withDefaults(defineProps<{ direction: 'horizontal' | 'vertical'; initialRatio?: number; min?: number }>(), { initialRatio: 0.5, min: 0.15 })
const emit = defineEmits<{ 'update:ratio': [ratio: number] }>()
const ratio = ref(clamp(props.initialRatio)); const dragging = ref(false)
const paneStyle = computed(() => ({ flexBasis: `${ratio.value * 100}%` })); const secondStyle = computed(() => ({ flexBasis: `${(1 - ratio.value) * 100}%` }))
function clamp(value: number): number { return Math.round(Math.min(1 - props.min, Math.max(props.min, value)) * 1000) / 1000 }
function setRatio(value: number): void { ratio.value = clamp(value); emit('update:ratio', ratio.value) }
function nudge(delta: number): void { setRatio(ratio.value + delta) }
function startDrag(event: MouseEvent): void { dragging.value = true; const move = (moveEvent: MouseEvent) => { const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setRatio(props.direction === 'horizontal' ? (moveEvent.clientX - rect.left) / rect.width : (moveEvent.clientY - rect.top) / rect.height) }; const stop = () => { dragging.value = false; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop) }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', stop) }
</script>

<style scoped>
.split-pane { display: flex; width: 100%; height: 100%; min-height: 0; }.split-pane--vertical { flex-direction: column; }.split-pane__pane { min-width: 0; min-height: 0; overflow: auto; }.split-pane__divider { flex: 0 0 6px; background: var(--color-border); cursor: col-resize; }.split-pane--vertical > .split-pane__divider { cursor: row-resize; }.split-pane__divider:focus-visible { background: var(--color-primary); }
</style>
