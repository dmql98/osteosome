<template>
  <span class="ui-spinner" :style="style" role="status" :aria-label="label ?? '加载中'">
    <span class="ui-spinner__ring" />
    <span v-if="label" class="ui-spinner__label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    size?: number
    label?: string
  }>(),
  { size: 16, label: undefined },
)

const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<style scoped>
.ui-spinner {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
}

.ui-spinner__ring {
  display: block;
  width: 100%;
  height: 100%;
  border: 2px solid var(--color-border-strong);
  border-top-color: var(--color-primary);
  border-radius: var(--radius-full);
  animation: ui-spinner-rotate 700ms linear infinite;
}

.ui-spinner__label {
  font-size: var(--text-sm);
}

@keyframes ui-spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-spinner__ring {
    animation-duration: 2400ms;
  }
}
</style>
