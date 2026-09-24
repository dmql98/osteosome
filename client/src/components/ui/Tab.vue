<template>
  <button
    class="ui-tab"
    :class="{ 'ui-tab--active': selected }"
    type="button"
    role="tab"
    :aria-selected="selected"
    :disabled="disabled"
    @click="onClick"
  >
    <slot>{{ label }}</slot>
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label?: string; selected?: boolean; disabled?: boolean }>(), { label: '', selected: false, disabled: false })

const emit = defineEmits<{ select: [] }>()

function onClick(): void {
  emit('select')
}
</script>

<style scoped>
.ui-tab { padding: var(--space-2) var(--space-3); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--color-text-muted); cursor: pointer; font-size: var(--text-sm); white-space: nowrap; }
.ui-tab:hover:not(:disabled) { color: var(--color-text); }
.ui-tab--active { border-bottom-color: var(--color-primary); color: var(--color-primary); }
.ui-tab:disabled { cursor: not-allowed; opacity: 0.5; }
</style>
