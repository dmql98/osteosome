<template>
  <label class="ui-checkbox" :class="{ 'ui-checkbox--disabled': disabled }">
    <input
      ref="el"
      class="ui-checkbox__input"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      :indeterminate.prop="indeterminate"
      @change="onChange"
    />
    <span class="ui-checkbox__box" aria-hidden="true" />
    <span v-if="label" class="ui-checkbox__label">{{ label }}</span>
  </label>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    label?: string
    disabled?: boolean
    indeterminate?: boolean
  }>(),
  { label: undefined, disabled: false, indeterminate: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function onChange(event: Event): void {
  if (props.disabled) return
  emit('update:modelValue', (event.target as HTMLInputElement).checked)
}
</script>

<style scoped>
.ui-checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
}

.ui-checkbox--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.ui-checkbox__input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.ui-checkbox__box {
  width: 15px;
  height: 15px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background-color: var(--color-surface);
  display: inline-block;
  position: relative;
  flex: none;
}

.ui-checkbox__input:checked + .ui-checkbox__box {
  background-color: var(--color-primary);
  border-color: var(--color-primary);
}

.ui-checkbox__input:checked + .ui-checkbox__box::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid var(--color-text-inverse);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.ui-checkbox__input:indeterminate + .ui-checkbox__box {
  background-color: var(--color-primary);
  border-color: var(--color-primary);
}

.ui-checkbox__input:indeterminate + .ui-checkbox__box::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 6px;
  width: 7px;
  height: 2px;
  background-color: var(--color-text-inverse);
}

.ui-checkbox__input:focus-visible + .ui-checkbox__box {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}
</style>
