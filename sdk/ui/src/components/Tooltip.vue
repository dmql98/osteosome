<template><span class="ui-tooltip" @mouseover="showSoon" @mouseout="hide" @focusin="show = true" @focusout="hide"><slot /><span v-if="show" class="ui-tooltip__content" role="tooltip">{{ content }}</span></span></template>

<script setup lang="ts">
import { ref, watch } from 'vue'
const props = withDefaults(defineProps<{ content: string; placement?: 'top' | 'bottom' | 'left' | 'right'; delay?: number }>(), { placement: 'top', delay: 0 })
const show = ref(false); let timer: ReturnType<typeof setTimeout> | undefined
function showSoon(): void { clearTimeout(timer); if (props.delay <= 0) { show.value = true; return }; timer = setTimeout(() => { show.value = true }, props.delay) }
function hide(): void { clearTimeout(timer); show.value = false }
watch(() => props.delay, () => { clearTimeout(timer) })
</script>

<style scoped>
.ui-tooltip { position: relative; display: inline-flex; }.ui-tooltip__content { position: absolute; z-index: var(--z-tooltip); padding: var(--space-1) var(--space-2); color: var(--color-text-inverse); background: var(--color-text); border-radius: var(--radius-sm); font-size: var(--text-xs); white-space: nowrap; pointer-events: none; }.ui-tooltip__content { top: auto; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
</style>
