<template>
  <div class="dockview-layout">
    <div class="dockview-layout__dock">
      <DockviewVue
        :components="components"
        :right-header-actions-component="headerActions"
        :default-tab-component="panelTab"
        :disable-dnd="false"
        dnd-strategy="pointer"
        @ready="onReady"
      />
    </div>
    <div v-if="!dockHasPanels" class="dockview-layout__fallback">
      <p>工作台为空，点右上角「添加面板」。</p>
    </div>
    <p v-if="store.lastError" class="dockview-layout__error" role="alert">{{ store.lastError }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { DockviewVue, type VueComponent } from 'dockview-vue'
import type { DockviewApi, DockviewReadyEvent } from 'dockview-core'
import { useLayoutStore } from './layout.store'
import { applyModeToAllGroups } from './mode'
import { applyDefaultLayout } from '../panes/default-layout'
import PanelContainer from '../panes/PanelContainer.vue'
import PanelHeaderActions from '../panes/PanelHeaderActions.vue'
import PanelTab from '../panes/PanelTab.vue'
import { PANEL_COMPONENT } from '../panes/types'

const store = useLayoutStore()
const components = { [PANEL_COMPONENT]: PanelContainer } as unknown as Record<string, VueComponent>
const headerActions = PanelHeaderActions as unknown as VueComponent
const panelTab = PanelTab as unknown as VueComponent
let api: DockviewApi | null = null
let disposers: Array<{ dispose(): void }> = []
let applying = false
const dockHasPanels = ref(false)

function applyLayout(): void {
  if (!api) return
  applying = true
  try {
    if (store.snapshot) api.fromJSON(store.snapshot)
    else applyDefaultLayout(api)
  } finally {
    applying = false
  }
  dockHasPanels.value = api.totalPanels > 0
  applyModeToAllGroups(api, store.mode)
}

function onReady(event: DockviewReadyEvent): void {
  api = event.api
  store.attachApi(event.api)
  applyLayout()
  if (store.hydrated && !store.snapshot) store.updateLayout(api.toJSON())
  disposers = [
    api.onDidLayoutChange(() => {
      if (!api) return
      dockHasPanels.value = api.totalPanels > 0
      if (applying) return
      store.updateLayout(api.toJSON())
    }),
    api.onDidAddGroup((group) => {
      group.locked = store.mode === 'runtime' ? 'no-drop-target' : false
      group.model.header.hidden = store.mode === 'runtime'
    }),
  ]
  window.addEventListener('osteosome:panel-layout', onInnerLayoutChange)
}

function onInnerLayoutChange(): void {
  if (api && !applying) store.updateLayout(api.toJSON())
}

watch(() => store.mode, (mode) => {
  if (api) applyModeToAllGroups(api, mode)
})

watch(() => store.hydrated, (hydrated) => {
  if (!hydrated || !api) return
  if (store.snapshot) applyLayout()
  else store.updateLayout(api.toJSON())
})

onBeforeUnmount(() => {
  window.removeEventListener('osteosome:panel-layout', onInnerLayoutChange)
  if (disposers.length) disposers.forEach((disposer) => disposer.dispose())
  disposers = []
  store.attachApi(null)
  api = null
})
</script>

<style scoped>
.dockview-layout { display: flex; flex: 1; width: 100%; height: 100%; min-height: 0; position: relative; }
.dockview-layout__dock { flex: 1 1 0%; min-width: 0; min-height: 0; position: relative; }
.dockview-layout__dock :deep(> div) { width: 100%; height: 100%; }
.dockview-layout :deep(.dv-shell) { --dv-sash-color: var(--color-border); --dv-active-sash-color: var(--color-primary); }
.dockview-layout__fallback { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; overflow: auto; background: var(--color-bg); color: var(--color-text-muted); font-size: var(--text-sm); }
.dockview-layout__error { position: absolute; left: var(--space-4); bottom: var(--space-4); margin: 0; padding: var(--space-2) var(--space-3); color: var(--color-danger); background: var(--color-danger-soft); border: 1px solid var(--color-danger); border-radius: var(--radius-md); font-size: var(--text-sm); }
</style>
