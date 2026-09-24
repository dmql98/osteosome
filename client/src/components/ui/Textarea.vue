<template>
  <textarea
    ref="el"
    class="ui-textarea"
    :value="modelValue"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-label="ariaLabel ?? placeholder"
    @input="onInput"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    rows?: number
    placeholder?: string
    disabled?: boolean
    autoGrow?: boolean
    ariaLabel?: string
  }>(),
  { rows: 3, placeholder: undefined, disabled: false, autoGrow: false, ariaLabel: undefined },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const el = ref<HTMLTextAreaElement | null>(null)

function resize(): void {
  const node = el.value
  if (!node || !props.autoGrow) return
  node.style.height = 'auto'
  node.style.height = `${node.scrollHeight}px`
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  resize()
}

watch(() => props.modelValue, () => resize())
</script>

<style scoped>
.ui-textarea {
  display: block;
  width: 100%;
  padding: var(--space-2);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: 1.5;
  resize: vertical;
}

.ui-textarea:focus {
  outline: none;
  border-color: var(--color-primary);
}

.ui-textarea:disabled {
  background-color: var(--color-surface-2);
  cursor: not-allowed;
  opacity: 0.7;
}
</style>
