<template><div class="ui-tabs"><div class="ui-tabs__list" role="tablist"><button v-for="tab in tabs" :key="tab.key" type="button" role="tab" :aria-selected="modelValue === tab.key" :disabled="tab.disabled" :class="{ 'ui-tabs__tab--active': modelValue === tab.key }" @click="select(tab.key)">{{ tab.label }}</button></div><div class="ui-tabs__content" role="tabpanel"><slot :name="`tab:${modelValue}`" :tab-key="modelValue"><slot /></slot></div></div></template>

<script setup lang="ts">
export interface TabItem { key: string; label: string; disabled?: boolean }
withDefaults(defineProps<{ tabs: TabItem[]; modelValue: string }>(), {})
const emit = defineEmits<{ 'update:modelValue': [key: string] }>()
function select(key: string): void { emit('update:modelValue', key) }
</script>

<style scoped>
.ui-tabs__list { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--color-border); }.ui-tabs__list button { padding: var(--space-2) var(--space-3); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--color-text-muted); cursor: pointer; }.ui-tabs__list button[aria-selected="true"] { border-bottom-color: var(--color-primary); color: var(--color-primary); }.ui-tabs__content { padding-top: var(--space-4); }
</style>
