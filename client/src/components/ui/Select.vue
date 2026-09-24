<template>
  <div class="ui-select" :class="{ 'ui-select--disabled': disabled }">
    <select
      class="ui-select__control"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="ariaLabel ?? placeholder"
      @change="onChange"
    >
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option
        v-for="option in options"
        :key="String(option.value)"
        :value="option.value"
        :disabled="option.disabled"
      >
        {{ option.label }}
      </option>
    </select>
    <span class="ui-select__arrow" aria-hidden="true">▾</span>
  </div>
</template>

<script setup lang="ts">
export interface SelectOption {
  label: string
  value: string | number
  disabled?: boolean
}

withDefaults(
  defineProps<{
    modelValue: string | number
    options: SelectOption[]
    disabled?: boolean
    placeholder?: string
    ariaLabel?: string
  }>(),
  { disabled: false, placeholder: undefined, ariaLabel: undefined },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<style scoped>
.ui-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 30px;
}

.ui-select__control {
  appearance: none;
  height: 100%;
  min-width: 120px;
  padding: 0 var(--space-5) 0 var(--space-2);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--text-sm);
  cursor: pointer;
}

.ui-select__control:focus {
  outline: none;
  border-color: var(--color-primary);
}

.ui-select--disabled .ui-select__control {
  background-color: var(--color-surface-2);
  cursor: not-allowed;
  opacity: 0.7;
}

.ui-select__arrow {
  position: absolute;
  right: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  pointer-events: none;
}
</style>
