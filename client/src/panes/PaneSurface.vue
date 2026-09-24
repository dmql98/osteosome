<template>
  <div class="pane-surface">
    <h2>{{ title }}</h2>
    <p>Pane 工作台骨架已就绪。这里将在 WS-4 接入真实 Pane 组件。</p>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ title?: string }>(), { title: '工作台' })
</script>

<style scoped>
.pane-surface { height: 100%; padding: var(--space-5); background: var(--color-surface); color: var(--color-text); }.pane-surface h2 { font-size: var(--text-lg); margin-bottom: var(--space-2); }.pane-surface p { color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
