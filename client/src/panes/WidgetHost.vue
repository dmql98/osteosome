<template>
  <component :is="widget" v-if="widget" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { getWidget, widgetComponents } from '../widgets/registry'

const props = defineProps<{ params?: { widgetId?: string } | { params?: { widgetId?: string } } }>()
const componentMap = widgetComponents()
const widget = computed(() => {
  const p = props.params as { params?: { widgetId?: string } } & { widgetId?: string } | undefined
  const id = (p?.params ?? p)?.widgetId
  return id && getWidget(id) ? componentMap[id] : null
})
</script>
