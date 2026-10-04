<template><article class="ui-card" :class="{ 'ui-card--hoverable': hoverable }"><header v-if="title || $slots.header" class="ui-card__header"><slot name="header"><h3 v-if="title">{{ title }}</h3></slot></header><div class="ui-card__body"><slot /></div><footer v-if="$slots.footer" class="ui-card__footer"><slot name="footer" /></footer></article></template>

<script setup lang="ts">
withDefaults(defineProps<{ title?: string; padding?: 'none' | 'sm' | 'md' | 'lg'; hoverable?: boolean }>(), { title: undefined, padding: 'md', hoverable: false })
</script>

<style scoped>
.ui-card { overflow: hidden; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }.ui-card--hoverable { transition: box-shadow var(--duration-base) ease, transform var(--duration-base) ease; }.ui-card--hoverable:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }.ui-card__header { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-border); font-weight: 600; }.ui-card__body { padding: var(--space-4); }.ui-card--padding-none > .ui-card__body { padding: 0; }.ui-card--padding-sm > .ui-card__body { padding: var(--space-2); }.ui-card--padding-lg > .ui-card__body { padding: var(--space-5); }.ui-card__footer { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--color-border); }
</style>
