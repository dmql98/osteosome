<template><div ref="root" class="ui-dropdown" @keydown.esc="close"><button class="ui-dropdown__trigger" type="button" :aria-expanded="open" :disabled="disabled" @click="toggle"><slot name="trigger">菜单</slot></button><div v-if="open" class="ui-dropdown__menu" role="menu"><button v-for="item in items" :key="item.value" type="button" role="menuitem" :class="{ 'ui-dropdown__item--danger': item.danger }" :disabled="item.disabled" @click="select(item.value)">{{ item.label }}</button></div></div></template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
export interface DropdownItem { label: string; value: string; disabled?: boolean; danger?: boolean }
const props = withDefaults(defineProps<{ items: DropdownItem[]; trigger?: 'click' | 'hover'; disabled?: boolean }>(), { trigger: 'click', disabled: false })
const emit = defineEmits<{ select: [value: string] }>(); const open = ref(false); const root = ref<HTMLElement | null>(null)
function toggle(): void { if (!props.disabled) open.value = !open.value }
function close(): void { open.value = false }
function select(value: string): void { emit('select', value); close() }
function onDocumentClick(event: MouseEvent): void { if (open.value && !root.value?.contains(event.target as Node)) close() }
document.addEventListener('click', onDocumentClick); onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<style scoped>
.ui-dropdown { position: relative; display: inline-block; }.ui-dropdown__trigger { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); padding: 6px 12px; cursor: pointer; }.ui-dropdown__menu { position: absolute; z-index: var(--z-dropdown); top: calc(100% + 4px); left: 0; min-width: 160px; padding: var(--space-1); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: var(--shadow-md); }.ui-dropdown__menu button { display: block; width: 100%; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius-sm); background: transparent; text-align: left; cursor: pointer; }.ui-dropdown__menu button:hover:not(:disabled) { background: var(--color-surface-2); }.ui-dropdown__item--danger { color: var(--color-danger); }
</style>
