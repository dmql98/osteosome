<template>
  <button
    class="ui-icon-button"
    :class="[`ui-icon-button--${size}`]"
    type="button"
    :disabled="disabled"
    :aria-label="label"
    @click="onClick"
  >
    <span class="ui-icon-button__icon" aria-hidden="true">{{ icon }}</span>
  </button>
</template>

<script setup lang="ts">
type IconButtonSize = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    icon: string
    size?: IconButtonSize
    disabled?: boolean
    label: string
  }>(),
  { size: 'md', disabled: false },
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

function onClick(event: MouseEvent): void {
  if (props.disabled) return
  emit('click', event)
}
</script>

<style scoped>
.ui-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  line-height: 1;
  transition: background-color var(--duration-fast) ease, color var(--duration-fast) ease;
}

.ui-icon-button:hover:not(:disabled) {
  background-color: var(--color-surface-2);
  color: var(--color-text);
}

.ui-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ui-icon-button--sm {
  width: 22px;
  height: 22px;
  font-size: var(--text-xs);
}

.ui-icon-button--md {
  width: 26px;
  height: 26px;
  font-size: var(--text-sm);
}

.ui-icon-button--lg {
  width: 32px;
  height: 32px;
  font-size: var(--text-lg);
}
</style>
