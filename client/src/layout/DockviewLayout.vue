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
import { onPanelWindowClosed } from './window-manager'
import { onMainWindowRequest } from './window-events'
import { usePluginStore } from '@/stores/plugin.store'
import { applyDefaultLayout } from '../panes/default-layout'
import PanelContainer from '../panes/PanelContainer.vue'
import PanelHeaderActions from '../panes/PanelHeaderActions.vue'
import PanelTab from '../panes/PanelTab.vue'
import { PANEL_COMPONENT } from '../panes/types'

const store = useLayoutStore()
const plugins = usePluginStore()
const components = { [PANEL_COMPONENT]: PanelContainer } as unknown as Record<string, VueComponent>
const headerActions = PanelHeaderActions as unknown as VueComponent
const panelTab = PanelTab as unknown as VueComponent
let api: DockviewApi | null = null
let disposers: Array<{ dispose(): void }> = []
let unsubWindowEvents: (() => void) | null = null
let applying = false
/**
 * 本次 `applyLayout()` 是不是拿**空清单**铺的默认布局。
 *
 * 启动时 `usePlugins()` 的 `GET /api/plugins` 是异步的，而 dockview 的 `@ready`
 * 往往先到 —— 于是第一次 `applyDefaultLayout(api, [])` 只会铺出一个空面板。
 * 清单到位后必须重铺一次，否则新装的用户永远看到「空面板」，
 * 明明插件管理里列得出 6 个组件。
 *
 * 只在「确实铺过空默认布局」时才重铺：用户有保存布局（`store.snapshot` 非空）
 * 的路径根本不会走 `applyDefaultLayout`，这里也就不该动它 —— 绝不能拿默认布局
 * 覆盖用户拖好的位置。
 */
let defaultAppliedFromEmptyCatalog = false
const dockHasPanels = ref(false)

function applyLayout(): void {
  if (!api) return
  applying = true
  try {
    if (store.snapshot) {
      api.fromJSON(store.snapshot)
      defaultAppliedFromEmptyCatalog = false
    } else {
      applyDefaultLayout(api, plugins.views)
      defaultAppliedFromEmptyCatalog = plugins.views.length === 0
    }
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
  if (store.hydrated) void store.reconcileDetached()
  disposers = [
    api.onDidLayoutChange(() => {
      if (!api) return
      dockHasPanels.value = api.totalPanels > 0
      if (applying) return
      store.updateLayout(api.toJSON())
    }),
    api.onDidAddGroup((group) => {
      // 只锁拖放，**不隐藏面板头** —— 见 mode.ts 的说明（用户反馈：运行模式不该藏工作台）
      group.locked = store.mode === 'runtime' ? 'no-drop-target' : false
    }),
  ]
  window.addEventListener('osteosome:panel-layout', onInnerLayoutChange)
  // 面板独立窗关闭：把对应 tab 放回工作台
  void onPanelWindowClosed((panelId) => store.restorePanel(panelId))
  // 插件列表 / 详情窗的跨窗请求：加入组件、或在插件状态变更后收敛布局
  void onMainWindowRequest({
    onAddWidget: (widgetId) => store.addWidget(widgetId),
    onPluginsChanged: async () => {
      await plugins.bootstrap()
      store.reconcilePlugins()
    },
  }).then((unsubscribe) => { unsubWindowEvents = unsubscribe })
}

function onInnerLayoutChange(): void {
  if (api && !applying) store.updateLayout(api.toJSON())
}

watch(() => store.mode, (mode) => {
  if (api) applyModeToAllGroups(api, mode)
})

/**
 * 清单比 dockview 晚到：把「空清单铺的默认布局」换成真正的默认布局。
 * `previous !== 0` 挡住后续 revision 抖动（启停、状态跃迁都不改 views.length）。
 */
watch(
  () => plugins.views.length,
  (count, previous) => {
    if (!api || !defaultAppliedFromEmptyCatalog || previous !== 0 || count === 0) return
    applying = true
    try {
      api.clear()
      applyDefaultLayout(api, plugins.views)
    } finally {
      applying = false
    }
    defaultAppliedFromEmptyCatalog = false
    dockHasPanels.value = api.totalPanels > 0
    applyModeToAllGroups(api, store.mode)
    store.updateLayout(api.toJSON())
  },
)

watch(() => store.hydrated, (hydrated) => {
  if (!hydrated || !api) return
  if (store.snapshot) applyLayout()
  else store.updateLayout(api.toJSON())
  void store.reconcileDetached()
})

onBeforeUnmount(() => {
  window.removeEventListener('osteosome:panel-layout', onInnerLayoutChange)
  if (disposers.length) disposers.forEach((disposer) => disposer.dispose())
  disposers = []
  unsubWindowEvents?.()
  unsubWindowEvents = null
  store.attachApi(null)
  api = null
})
</script>

<style scoped>
.dockview-layout { display: flex; flex: 1; width: 100%; height: 100%; min-height: 0; position: relative; }
.dockview-layout__dock { flex: 1 1 0%; min-width: 0; min-height: 0; position: relative; }
.dockview-layout__dock :deep(> div) { width: 100%; height: 100%; }
.dockview-layout :deep(.dv-shell) {
  --dv-sash-color: var(--color-border);
  --dv-active-sash-color: var(--color-primary);
  /* 面板标签栏：工业蓝底 + 高对比浅色文字（与工作台导航栏一致） */
  --dv-tabs-and-actions-container-background-color: var(--color-topbar-bg);
  --dv-activegroup-visiblepanel-tab-background-color: var(--color-topbar-overlay-strong);
  --dv-activegroup-hiddenpanel-tab-background-color: transparent;
  --dv-activegroup-visiblepanel-tab-color: var(--color-topbar-text);
  --dv-activegroup-hiddenpanel-tab-color: var(--color-topbar-text-muted);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--color-topbar-overlay);
  --dv-inactivegroup-hiddenpanel-tab-background-color: transparent;
  --dv-inactivegroup-visiblepanel-tab-color: var(--color-topbar-text-muted);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--color-topbar-text-muted);
  --dv-tab-divider-color: var(--color-topbar-overlay-strong);
  --dv-group-view-background-color: var(--color-surface);
  --dv-floating-titlebar-background-color: var(--color-topbar-bg);
}
/*
 * 「面板顶栏悬停才浮现」已删除。
 *
 * 原来运行模式给顶栏加 `opacity: 0; pointer-events: none`，靠悬停渐显 ——
 * 用户反馈「运行模式连工作台都会隐藏，面板在运行模式也是不要隐藏的」。
 * 运行模式是正常使用的模式，顶栏常驻。
 */
.dockview-layout__fallback { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; overflow: auto; background: var(--color-bg); color: var(--color-text-muted); font-size: var(--text-sm); }
.dockview-layout__error { position: absolute; left: var(--space-4); bottom: var(--space-4); margin: 0; padding: var(--space-2) var(--space-3); color: var(--color-danger); background: var(--color-danger-soft); border: 1px solid var(--color-danger); border-radius: var(--radius-md); font-size: var(--text-sm); }
</style>
