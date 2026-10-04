<template>
  <div class="ui-input" :class="{ 'ui-input--disabled': disabled }">
    <span v-if="$slots.prefix" class="ui-input__affix"><slot name="prefix" /></span>
    <input
      class="ui-input__control"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-label="ariaLabel ?? placeholder"
      @input="onInput"
      @keydown.enter="emit('enter', modelValue)"
    />
    <button
      v-if="clearable && modelValue !== ''"
      class="ui-input__clear"
      type="button"
      :aria-label="clearLabel"
      :disabled="disabled"
      @click="onClear"
    >
      ×
    </button>
    <span v-if="$slots.suffix" class="ui-input__affix"><slot name="suffix" /></span>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    disabled?: boolean
    type?: 'text' | 'password' | 'search' | 'email'
    clearable?: boolean
    ariaLabel?: string
    clearLabel?: string
  }>(),
  {
    placeholder: undefined,
    disabled: false,
    type: 'text',
    clearable: false,
    ariaLabel: undefined,
    clearLabel: '清空',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  clear: []
  enter: [value: string]
}>()

function onInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  emit('update:modelValue', value)
}

function onClear(): void {
  if (props.disabled) return
  emit('update:modelValue', '')
  emit('clear')
}
</script>

<style scoped>
.ui-input {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-2);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
}

.ui-input:focus-within {
  border-color: var(--color-primary);
}

.ui-input--disabled {
  background-color: var(--color-surface-2);
  opacity: 0.7;
}

.ui-input__control {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
}

.ui-input__control::placeholder {
  color: var(--color-text-muted);
}

.ui-input__clear {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--text-md);
  line-height: 1;
  padding: 0 2px;
}

.ui-input__affix {
  display: inline-flex;
  align-items: center;
  font-size: var(--text-sm);
}
</style>
