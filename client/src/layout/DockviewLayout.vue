<template>
  <div class="dockview-layout">
    <DockviewVue
      class="dockview-layout__dock"
      :components="components"
      :disable-dnd="false"
      @ready="onReady"
    />
    <div v-if="!dockHasPanels" class="dockview-layout__fallback">
      <HelloPane />
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
import { fromDockviewGrid, toDockviewGrid } from './layout.model'
import PaneView from '../panes/PaneView.vue'
import HelloPane from '../features/hello/HelloPane.vue'
import { defaultPanelsFor, listPanes } from '../panes/registry'
import type { PaneMeta } from './types'

const store = useLayoutStore()
const components = { PaneView } as unknown as Record<string, VueComponent>
let api: DockviewApi | null = null
let disposers: Array<{ dispose(): void }> = []
let applying = false
const dockHasPanels = ref(false)
const paneMeta = new Map<string, PaneMeta>(listPanes().map((pane) => [pane.id, { title: pane.title }]))

function syncFromDockview(): void {
  if (!api || applying) return
  store.updateWorkspace({ ...store.workspace, dock: fromDockviewGrid(api.toJSON()) })
}

function onReady(event: DockviewReadyEvent): void {
  api = event.api
  applying = true
  api.fromJSON(toDockviewGrid(defaultPanelsFor(store.workspace).dock, paneMeta))
  dockHasPanels.value = api.totalPanels > 0
  applying = false
  applyModeToAllGroups(api, store.mode)
  disposers = [
    api.onDidLayoutChange(() => { if (api) dockHasPanels.value = api.totalPanels > 0; syncFromDockview() }),
    api.onDidAddGroup((group) => {
      group.locked = store.mode === 'runtime' ? 'no-drop-target' : false
      group.model.header.hidden = store.mode === 'runtime'
    }),
  ]
}

watch(() => store.mode, (mode) => {
  if (api) applyModeToAllGroups(api, mode)
})

watch(() => store.hydrated, (hydrated) => {
  if (!hydrated || !api) return
  applying = true
  api.fromJSON(toDockviewGrid(store.workspace.dock, paneMeta))
  dockHasPanels.value = api.totalPanels > 0
  applying = false
  applyModeToAllGroups(api, store.mode)
})

onBeforeUnmount(() => {
  if (disposers.length) disposers.forEach((disposer) => disposer.dispose())
  disposers = []
  api = null
})
</script>

<style scoped>
.dockview-layout { display: flex; flex: 1; width: 100%; height: 100%; min-height: 0; position: relative; }
.dockview-layout__dock { flex: 1; min-height: 0; }
.dockview-layout__fallback { position: absolute; inset: 0; z-index: 1; overflow: auto; background: var(--color-bg); }
.dockview-layout__error { position: absolute; left: var(--space-4); bottom: var(--space-4); margin: 0; padding: var(--space-2) var(--space-3); color: var(--color-danger); background: var(--color-danger-soft); border: 1px solid var(--color-danger); border-radius: var(--radius-md); font-size: var(--text-sm); }
</style>
