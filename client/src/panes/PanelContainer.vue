<template>
  <div class="panel-boxes">
    <div ref="canvas" class="panel-boxes__canvas">
      <MovableBox
        v-for="widget in visible"
        :key="widget.id"
        v-model="widget.rect"
        class="panel-boxes__item"
        drag-handle=".panel-boxes__header"
        :snap-to-elements="true"
        :snap-targets="snapTargets"
        @drag-stop="persist"
        @resize-stop="persist"
      >
        <header class="panel-boxes__header">{{ widget.title }}</header>
        <div class="panel-boxes__body"><component :is="widget.component" /></div>
      </MovableBox>
      <p v-if="visible.length === 0" class="panel-boxes__empty">空面板 · 用「添加组件」放入组件</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, ref, watch } from 'vue'
import { MovableBox, type MovableBoxRect } from 'vue-movable-box'
import { getWidget, widgetComponents } from '../widgets/registry'

type WidgetBox = { id: string; title: string; component: unknown; rect: MovableBoxRect }
type PanelContainerParams = { widgets?: string[]; title?: string; layout?: Record<string, MovableBoxRect> }
const props = defineProps<{ params?: PanelContainerParams | { params?: PanelContainerParams; api?: { updateParameters?: (p: object) => void } } }>()
const resolved = computed<PanelContainerParams>(() => {
  const p = props.params as ({ params?: PanelContainerParams } & PanelContainerParams) | undefined
  return p?.params ?? p ?? {}
})
const panelApi = computed(() => (props.params as { api?: { updateParameters?: (p: object) => void } } | undefined)?.api)
const widgets = computed(() => resolved.value.widgets ?? [])
const saved = computed(() => resolved.value.layout ?? {})
const canvas = ref<HTMLElement | null>(null)
const componentMap = widgetComponents()
const gridSize = 8

function defaultRect(index: number): MovableBoxRect {
  const width = 360
  const height = 240
  const cols = Math.max(1, Math.floor((canvas.value?.clientWidth ?? 1080) / (width + gridSize)))
  return {
    left: gridSize + (index % cols) * (width + gridSize),
    top: gridSize + Math.floor(index / cols) * (height + gridSize),
    width,
    height,
    zIndex: index + 1,
  }
}

const visible = ref<WidgetBox[]>([])

function rebuild(): void {
  visible.value = widgets.value.flatMap((id, index) => {
    const widget = getWidget(id)
    if (!widget) return []
    return [{ id, title: widget.title, component: markRaw(componentMap[id] as object), rect: saved.value[id] ?? defaultRect(index) }]
  })
}

const snapTargets = computed(() => visible.value.map((widget) => ({ ...widget.rect, id: widget.id })))

function persist(): void {
  panelApi.value?.updateParameters?.({
    widgets: widgets.value,
    layout: Object.fromEntries(visible.value.map((widget) => [widget.id, widget.rect])),
  })
  window.dispatchEvent(new CustomEvent('osteosome:panel-layout'))
}

onMounted(() => nextTick(rebuild))
watch(widgets, rebuild)
watch(saved, () => { if (visible.value.length) rebuild() })
</script>

<style scoped>
.panel-boxes { height: 100%; min-height: 0; overflow: auto; background: var(--color-surface-2); }
.panel-boxes__canvas { position: relative; min-height: 100%; height: 100%; }
.panel-boxes__item { display: flex; flex-direction: column; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); overflow: hidden; }
.panel-boxes__header { flex: 0 0 auto; height: 26px; display: flex; align-items: center; padding: 0 var(--space-3); font-size: var(--text-xs); font-weight: 600; color: var(--color-text-muted); background: var(--color-surface-2); border-bottom: 1px solid var(--color-border); cursor: move; user-select: none; }
.panel-boxes__body { flex: 1; min-height: 0; overflow: auto; padding: var(--space-3); }
.panel-boxes__empty { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
