<template><div class="ui-list"><template v-if="items.length"><button v-for="(item, index) in items" :key="index" class="ui-list__item" type="button" @click="select(index)"><slot name="item" :item="item" :index="index">{{ item }}</slot></button></template><div v-else class="ui-list__empty"><slot name="empty">暂无数据</slot></div></div></template>

<script setup lang="ts">
defineProps<{ items: unknown[]; virtual?: boolean }>()
const emit = defineEmits<{ select: [index: number] }>()
function select(index: number): void { emit('select', index) }
</script>

<style scoped>
.ui-list { display: grid; gap: 2px; }.ui-list__item { display: block; width: 100%; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius-sm); background: transparent; text-align: left; cursor: pointer; }.ui-list__item:hover { background: var(--color-surface-2); }.ui-list__empty { padding: var(--space-5); color: var(--color-text-muted); text-align: center; }
</style>
