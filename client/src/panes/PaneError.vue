<template>
  <div class="pane-error" role="alert">
    <strong>{{ title }}</strong>
    <span>{{ detail }}</span>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ title?: string; detail?: string }>(), { title: 'Pane 加载失败', detail: '请返回编辑模式后重试。' })
</script>

<style scoped>
.pane-error { display: grid; gap: var(--space-1); height: 100%; padding: var(--space-4); color: var(--color-danger); background: var(--color-danger-soft); font-size: var(--text-sm); }
</style>
