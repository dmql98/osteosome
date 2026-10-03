<template>
  <div class="panel-boxes" :class="`panel-boxes--${modeClass}`" @pointerdown="onCanvasPointerDown">
    <div ref="canvas" class="panel-boxes__canvas">
      <MovableGroup v-model:selected="selectedIds" @move-stop="persist">
        <MovableBox
          v-for="widget in visible"
          :key="widget.id"
          v-model="widget.rect"
          :member-id="widget.id"
          class="panel-boxes__item"
          :class="{ 'panel-boxes__item--selected': isSelected(widget.id) }"
          :active="editable && isSelected(widget.id)"
          :draggable="editable"
          :resizable="editable"
          :disabled="!editable"
          :snap-to-elements="editable"
          :snap-targets="editable ? snapTargets : []"
          @resize-stop="persist"
          @pointerdown.stop="onBoxPointerDown(widget.id, $event)"
        >
          <header v-if="editable && isSelected(widget.id)" class="panel-boxes__header">
            <span class="panel-boxes__title">{{ widget.title }}</span>
            <button
              v-for="layer in layerActions"
              :key="layer.direction"
              type="button"
              class="panel-boxes__layer"
              :title="layer.label"
              :aria-label="layer.label"
              @pointerdown.stop
              @click.stop="moveLayer(widget.id, layer.direction)"
            >{{ layer.glyph }}</button>
            <button
              type="button"
              class="panel-boxes__remove"
              title="从面板移除"
              aria-label="从面板移除组件"
              @pointerdown.stop
              @click.stop="removeWidget(widget.id)"
            >×</button>
          </header>
          <div class="panel-boxes__body"><component :is="widget.component" /></div>
        </MovableBox>
      </MovableGroup>
      <p v-if="visible.length === 0" class="panel-boxes__empty">空面板 · 到「插件管理」里选组件加入</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { MovableBox, MovableGroup, type MovableBoxRect } from 'vue-movable-box'
import { useLayoutStore } from '../layout/layout.store'
import { usePluginStore } from '../stores/plugin.store'
import { getWidget, widgetComponents } from '../widgets/registry'
import { chatThreeBoxRectsFor } from './default-layout'

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

// 编辑模式才可拖拽/缩放：运行时锁定组件位置与大小
const layoutStore = useLayoutStore()
const pluginStore = usePluginStore()
const { mode } = storeToRefs(layoutStore)
const editable = computed(() => mode.value === 'edit')
const modeClass = computed(() => (editable.value ? 'edit' : 'runtime'))
// 当前选中的组件：可多选（Ctrl/Cmd/Shift 点选加减），拖任一个选中项一起移动。
const selectedIds = ref<string[]>([])
const layerActions = [
  { direction: 1, label: '上移一层', glyph: '↑' },
  { direction: -1, label: '下移一层', glyph: '↓' },
] as const

function isSelected(id: string): boolean {
  return selectedIds.value.includes(id)
}

function onBoxPointerDown(id: string, event: PointerEvent): void {
  if (!editable.value) return
  const additive = event.ctrlKey || event.metaKey || event.shiftKey
  if (additive) {
    selectedIds.value = isSelected(id)
      ? selectedIds.value.filter((item) => item !== id)
      : [...selectedIds.value, id]
  } else if (!isSelected(id)) {
    selectedIds.value = [id]
  }
}
function onCanvasPointerDown(): void {
  if (editable.value) selectedIds.value = []
}

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

/**
 * S6：初始几何在 `rebuild()` 里定 —— 优先级 `保存的 rect > 三盒预设 > 通用网格`。
 * 用户拖过之后保存的 rect 说了算（那是用户的选择），预设只负责「第一次打开时的样子」。
 */
const visible = ref<WidgetBox[]>([])

function rebuild(): void {
  const presets = chatThreeBoxRectsFor(canvas.value)
  visible.value = widgets.value.flatMap((id, index) => {
    // 停用 / 已卸载插件的组件不渲染（停用仅隐藏，重新启用自动恢复）
    if (!pluginStore.isWidgetEnabled(id)) return []
    const widget = getWidget(id)
    if (!widget) return []
    const rect = saved.value[id] ?? presets[id] ?? defaultRect(index)
    return [{ id, title: widget.title, component: markRaw(componentMap[id] as object), rect }]
  })
  const alive = new Set(visible.value.map((widget) => widget.id))
  selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
}

const snapTargets = computed(() => visible.value.map((widget) => ({ ...widget.rect, id: widget.id })))

function writeWidgets(nextWidgets: string[], nextVisible: WidgetBox[] = visible.value): void {
  panelApi.value?.updateParameters?.({
    widgets: nextWidgets,
    layout: Object.fromEntries(nextVisible.map((widget) => [widget.id, widget.rect])),
  })
  window.dispatchEvent(new CustomEvent('osteosome:panel-layout'))
}

function persist(): void {
  writeWidgets(widgets.value)
}

/** 从本面板移除组件：更新 params.widgets 并同步几何，由 DockviewLayout 回写快照。 */
function removeWidget(id: string): void {
  writeWidgets(
    widgets.value.filter((widgetId) => widgetId !== id),
    visible.value.filter((widget) => widget.id !== id),
  )
}

/** 调整组件层级：direction=1 上移一层，-1 下移一层。相邻交换后归一化 z 序（防止历史 zIndex 重复）。 */
function moveLayer(id: string, direction: 1 | -1): void {
  const ordered = [...visible.value].sort((a, b) => (a.rect.zIndex ?? 0) - (b.rect.zIndex ?? 0))
  const from = ordered.findIndex((widget) => widget.id === id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= ordered.length) return
  ;[ordered[from], ordered[to]] = [ordered[to], ordered[from]]
  ordered.forEach((widget, index) => { widget.rect.zIndex = index + 1 })
  persist()
}

onMounted(() => nextTick(rebuild))
watch(widgets, rebuild)
watch(saved, () => { if (visible.value.length) rebuild() })
watch(() => pluginStore.revision, rebuild)
</script>

<style scoped>
.panel-boxes { height: 100%; min-height: 0; overflow: auto; background: var(--color-surface-2); }
.panel-boxes__canvas { position: relative; min-height: 100%; height: 100%; }
.panel-boxes__item { display: flex; flex-direction: column; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); overflow: hidden; }
.panel-boxes__item--selected { border-color: var(--color-primary); box-shadow: var(--shadow-md); }
/*
 * 运行模式**不是「禁用」，是「不可拖动」**。
 *
 * MovableBox 的 `disabled` 会给盒子加 `.is-disabled`，而它的样式是
 * `cursor: not-allowed !important` + `opacity: .6`，外加 `.auto-draggable` 自带
 * `user-select: none`。三个副作用在运行模式下全是错的：
 *
 * · 盒子铺满整个面板 → **到处都是禁止光标**
 * · 所有组件被淡化到 60% → 运行模式才是「正常用」的模式，不该看起来像坏了
 * · 选不中文本 → 对话记录里的报错、模型名都复制不了
 *
 * 所以这里覆盖掉这三个副作用，而**保留 `disabled` 本身** ——
 * 手柄必须继续隐藏（运行时不该出现缩放圆点）。
 *
 * 注意要写 `!important`：库那边就是 `!important`，非 important 声明压不过它
 * （特异性再高也没用）。
 */
.panel-boxes--runtime .panel-boxes__item.is-disabled {
  cursor: auto;
  opacity: 1;
  user-select: auto;
  -webkit-user-select: auto;
}
.panel-boxes--runtime .panel-boxes__item.is-disabled * {
  cursor: auto;
  user-select: auto;
  -webkit-user-select: auto;
}

.panel-boxes--edit .panel-boxes__item { border-style: dashed; cursor: move; }
.panel-boxes__header { flex: 0 0 auto; height: 26px; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); font-size: var(--text-xs); font-weight: 600; color: var(--color-topbar-text); background: linear-gradient(180deg, var(--color-topbar-bg) 0%, var(--color-topbar-bg-2) 100%); border-bottom: 1px solid var(--color-topbar-border); user-select: none; }
.panel-boxes__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-boxes__remove,
.panel-boxes__layer { flex: none; width: 16px; height: 16px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-topbar-text-muted); font-size: var(--text-sm); line-height: 1; cursor: pointer; }
.panel-boxes__remove:hover,
.panel-boxes__layer:hover { background: var(--color-topbar-overlay-strong); color: var(--color-topbar-text); }
/* 缩放把手：隐藏库默认的方块外观，opacity:0 仍保留热区与缩放光标，缩放功能不受影响 */
.panel-boxes__item :deep(.handle) { opacity: 0; }
.panel-boxes__body { flex: 1; min-height: 0; overflow: auto; padding: var(--space-3); }
/* 组件内容自适应：内容根节点至少撑满盒子，随盒子缩放自适应；超出部分在盒内滚动 */
.panel-boxes__body > :deep(*) { min-height: 100%; }
.panel-boxes__empty { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
