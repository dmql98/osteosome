<template><header class="page-header"><button v-if="back" class="page-header__back" type="button" aria-label="返回" @click="emit('back')">←</button><div class="page-header__copy"><h1>{{ title }}</h1><p v-if="subtitle">{{ subtitle }}</p></div><div class="page-header__actions"><slot name="actions" /></div></header></template>

<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; back?: boolean }>()
const emit = defineEmits<{ back: [] }>()
</script>

<style scoped>
.page-header { display: flex; align-items: center; gap: var(--space-3); min-height: 48px; margin-bottom: var(--space-4); }.page-header__back { width: 30px; height: 30px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); cursor: pointer; }.page-header__copy { flex: 1; min-width: 0; }.page-header h1 { font-size: var(--text-xl); }.page-header p { margin-top: var(--space-1); color: var(--color-text-muted); font-size: var(--text-sm); }.page-header__actions { display: flex; gap: var(--space-2); }
</style>
