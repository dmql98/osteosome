<template><div class="ui-empty-state"><div v-if="icon" class="ui-empty-state__icon" aria-hidden="true">{{ icon }}</div><h3 class="ui-empty-state__title">{{ title }}</h3><p v-if="description" class="ui-empty-state__description">{{ description }}</p><div v-if="$slots.action" class="ui-empty-state__action"><slot name="action" /></div></div></template>

<script setup lang="ts">
defineProps<{ icon?: string; title: string; description?: string }>()
</script>

<style scoped>
.ui-empty-state { display: grid; justify-items: center; gap: var(--space-2); padding: var(--space-6) var(--space-4); color: var(--color-text-muted); text-align: center; }.ui-empty-state__icon { font-size: 28px; }.ui-empty-state__title { color: var(--color-text); font-size: var(--text-md); }.ui-empty-state__description { max-width: 420px; font-size: var(--text-sm); }.ui-empty-state__action { margin-top: var(--space-2); }
</style>
