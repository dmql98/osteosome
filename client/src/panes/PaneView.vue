<template>
  <PaneFrame v-if="definition" :definition="definition" :api="panelApi" @close="closePane" @reset="resetLayout" @detach="detach">
    <HelloPane v-if="definition?.id === 'pane.hello'" />
    <component :is="renderedPane" v-else-if="definition && renderedPane" :pane-id="definition.id" />
    <PaneError v-else-if="loadError" />
    <div v-else-if="definition" class="pane-loading" role="status">正在加载 {{ definition.title }}…</div>
  </PaneFrame>
  <PaneError v-else title="Pane 不存在" detail="该 Pane 未注册到当前工作台。" />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, shallowRef, ref, watch, type Component } from 'vue'
import HelloPane from '../features/hello/HelloPane.vue'
import type { DockviewApi } from 'dockview-core'
import { getPane } from './registry'
import PaneError from './PaneError.vue'
import PaneFrame from './PaneFrame.vue'
import { useLayoutStore } from '../layout/layout.store'
import { openPanelWindow } from '../layout/window-manager'
import type { PaneDefinition } from './types'

type DockviewParams = {
  paneId?: string
  params?: { paneId?: string }
  api?: { close?: () => void }
  containerApi?: DockviewApi
}
const props = defineProps<{ params?: DockviewParams; api?: { close?: () => void }; containerApi?: DockviewApi }>()
const panelParams = computed(() => props.params?.params ?? props.params)
const definition = computed<PaneDefinition | undefined>(() => getPane(panelParams.value?.paneId ?? ''))
const panelApi = computed(() => props.params?.api ?? props.api)
const containerApi = computed(() => props.params?.containerApi ?? props.containerApi)
const layout = useLayoutStore()
const asyncPane = shallowRef<Component | null>(null)
const renderedPane = computed<Component | null>(() => asyncPane.value)
const loadError = ref(false)

function loadPane(): void {
  const pane = definition.value
  if (!pane) return
  loadError.value = false
  asyncPane.value = pane.id === 'pane.hello'
    ? HelloPane
    : defineAsyncComponent({
        loader: async () => {
          const module = await pane.component()
          return module.default
        },
        timeout: 10_000,
        onError(_error, _retry, fail) { loadError.value = true; fail() },
        delay: 0,
      })
}
loadPane()
watch(definition, loadPane)
function closePane(): void { panelApi.value?.close?.() }
function resetLayout(): void { layout.resetLayout() }
function detach(): void {
  const pane = definition.value
  if (pane && pane.windowable !== false) openPanelWindow(pane.id, [])
}
</script>

<style scoped>
.pane-loading { display: grid; place-items: center; height: 100%; color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
