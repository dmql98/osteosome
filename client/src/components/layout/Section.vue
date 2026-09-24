<template><section class="section"><header v-if="title || collapsible" class="section__header"><h2 v-if="title">{{ title }}</h2><button v-if="collapsible" type="button" :aria-expanded="open" @click="toggle">{{ open ? '▾' : '▸' }}</button></header><div v-show="open" class="section__body"><slot /></div></section></template>

<script setup lang="ts">
import { ref, watch } from 'vue'
const props = withDefaults(defineProps<{ title?: string; collapsible?: boolean; defaultOpen?: boolean }>(), { title: undefined, collapsible: false, defaultOpen: true })
const emit = defineEmits<{ toggle: [open: boolean] }>(); const open = ref(props.defaultOpen)
watch(() => props.defaultOpen, (value) => { open.value = value })
function toggle(): void { open.value = !open.value; emit('toggle', open.value) }
</script>

<style scoped>
.section { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }.section__header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); }.section__header h2 { font-size: var(--text-md); }.section__header button { border: 0; background: transparent; cursor: pointer; }.section__body { padding: 0 var(--space-4) var(--space-4); }
</style>
