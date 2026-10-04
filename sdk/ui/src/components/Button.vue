<template>
  <button
    class="ui-button"
    :class="[`ui-button--${variant}`, `ui-button--${size}`]"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="onClick"
  >
    <Spinner v-if="loading" class="ui-button__spinner" :size="spinnerSize" />
    <span class="ui-button__label"><slot /></span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Spinner from './Spinner.vue'

type ButtonVariant = 'primary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant
    size?: ButtonSize
    disabled?: boolean
    loading?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  { variant: 'primary', size: 'md', disabled: false, loading: false, type: 'button' },
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

const spinnerSize = computed(() => (props.size === 'sm' ? 12 : props.size === 'lg' ? 16 : 14))

function onClick(event: MouseEvent): void {
  if (props.disabled || props.loading) return
  emit('click', event)
}
</script>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--duration-fast) ease, border-color var(--duration-fast) ease;
}

.ui-button--sm {
  height: 24px;
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
}

.ui-button--md {
  height: 30px;
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
}

.ui-button--lg {
  height: 38px;
  padding: 0 var(--space-4);
  font-size: var(--text-md);
}

.ui-button--primary {
  background-color: var(--color-primary);
  color: var(--color-text-inverse);
}

.ui-button--primary:hover:not(:disabled) {
  background-color: var(--color-primary-hover);
}

.ui-button--ghost {
  background-color: transparent;
  border-color: var(--color-border);
  color: var(--color-text);
}

.ui-button--ghost:hover:not(:disabled) {
  background-color: var(--color-surface-2);
  border-color: var(--color-border-strong);
}

.ui-button--danger {
  background-color: var(--color-danger);
  color: var(--color-text-inverse);
}

.ui-button--danger:hover:not(:disabled) {
  filter: brightness(0.94);
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-button__spinner .ui-spinner__ring {
  border-top-color: currentColor;
  border-color: currentColor;
  border-top-color: transparent;
}
</style>
