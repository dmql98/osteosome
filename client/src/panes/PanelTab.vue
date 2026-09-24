<template>
  <Tab class="panel-tab" :label="title" :selected="active" @select="activate" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Tab from '../components/ui/Tab.vue'

type PanelApi = {
  title?: string
  isActive?: boolean
  setActive?: () => void
  onDidActiveChange?: (cb: (event: { isActive: boolean }) => void) => { dispose(): void }
  onDidTitleChange?: (cb: (event: { title: string }) => void) => { dispose(): void }
}
const props = defineProps<{ params?: { api?: PanelApi } | { params?: { api?: PanelApi } } }>()
const api = computed<PanelApi | undefined>(() => {
  const p = props.params as ({ params?: { api?: PanelApi } } & { api?: PanelApi }) | undefined
  return p?.api ?? p?.params?.api
})
const title = ref('')
const active = ref(false)
const disposers: Array<{ dispose(): void }> = []

watch(api, (next) => {
  disposers.forEach((d) => d.dispose())
  disposers.length = 0
  title.value = next?.title ?? ''
  active.value = next?.isActive ?? false
  if (!next) return
  if (next.onDidActiveChange) disposers.push(next.onDidActiveChange((event) => { active.value = event.isActive }))
  if (next.onDidTitleChange) disposers.push(next.onDidTitleChange((event) => { title.value = event.title }))
}, { immediate: true })

onBeforeUnmount(() => disposers.forEach((d) => d.dispose()))

function activate(): void { api.value?.setActive?.() }
</script>

<style scoped>
.panel-tab { height: 100%; padding: 0; border-bottom: 0; }
</style>
