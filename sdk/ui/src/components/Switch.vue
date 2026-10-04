<template>
  <button
    class="ui-switch"
    :class="{ 'ui-switch--on': modelValue, 'ui-switch--disabled': disabled }"
    type="button"
    role="switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="onToggle"
  >
    <span class="ui-switch__track" aria-hidden="true">
      <span class="ui-switch__thumb" />
    </span>
    <span v-if="label" class="ui-switch__label">{{ label }}</span>
  </button>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    disabled?: boolean
    label?: string
    ariaLabel?: string
  }>(),
  { disabled: false, label: undefined, ariaLabel: undefined },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function onToggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<style scoped>
.ui-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--color-text);
  cursor: pointer;
}

.ui-switch--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.ui-switch__track {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: var(--radius-full);
  background-color: var(--color-surface-3);
  transition: background-color var(--duration-fast) ease;
  flex: none;
}

.ui-switch--on .ui-switch__track {
  background-color: var(--color-primary);
}

.ui-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background-color: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transition: transform var(--duration-fast) ease;
}

.ui-switch--on .ui-switch__thumb {
  transform: translateX(14px);
}
</style>
