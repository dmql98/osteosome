<template>
  <div class="panel-boxes" :class="`panel-boxes--${modeClass}`" @pointerdown="onCanvasPointerDown">
    <div ref="canvas" class="panel-boxes__canvas" :style="gridStyle">
      <!--
        `selected` 只往下传、**不接库的 update:selected**（不是 v-model）。
        库在 pointerdown 时会「按下的那个即选中集」把组选中集收窄并 emit 出来
        （beginDrag -> tt([pressed])），而它的监听器比我们的 @pointerdown 早跑，
        emit 会把 `onBoxPointerDown` 刚算好的 Ctrl 多选直接盖掉 —— 表现是
        Ctrl+点第二个框之后**一个都没选中**。选中权留给我们自己，库只读。
      -->
      <MovableGroup :selected="selectedIds" @move-stop="onMoveStop">
        <MovableBox
          v-for="widget in visible"
          :key="widget.id"
          v-model="widget.rect"
          :member-id="widget.id"
          unit-type="%"
          :is-keep-decimals="true"
          class="panel-boxes__item"
          :class="{ 'panel-boxes__item--selected': isSelected(widget.id) }"
          :active="editable && isSelected(widget.id)"
          :draggable="editable"
          :resizable="editable"
          :disabled="!editable"
          :snap-to-elements="editable"
          :snap-targets="editable ? snapTargets : []"
          @drag-stop="onInteractionStop(widget)"
          @resize-stop="onInteractionStop(widget)"
          @pointerdown.stop="onBoxPointerDown(widget.id, $event)"
        >
          <header v-if="editable && isSelected(widget.id)" class="panel-boxes__header">
            <span class="panel-boxes__title">{{ widget.title }}</span>
            <button
              type="button"
              class="panel-boxes__layer panel-boxes__fullscreen"
              :title="isFullscreenRect(widget.rect) ? '还原大小' : '撑满工作台'"
              :aria-label="isFullscreenRect(widget.rect) ? '还原大小' : '撑满工作台'"
              @pointerdown.stop
              @click.stop="toggleFullscreen(widget.id)"
            >{{ isFullscreenRect(widget.rect) ? '⤡' : '⤢' }}</button>
            <input
              class="panel-boxes__layer-input"
              type="number"
              :min="1"
              :max="visible.length"
              :value="layerOf(widget.id)"
              title="所在层（1 = 最底层）"
              aria-label="所在层"
              @pointerdown.stop
              @change="setLayer(widget.id, $event)"
            />
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
          <div class="panel-boxes__body">
            <component :is="widget.resolved.component" v-if="widget.resolved.kind === 'local'" />
            <PluginWidgetHost
              v-else-if="widget.resolved.kind === 'iframe'"
              :src="widget.resolved.src"
              :title="widget.resolved.title"
            />
            <div v-else class="widget-missing">
              <p class="widget-missing__title">
                {{ widget.resolved.title }}
                {{ widget.resolved.reason === 'removed' ? '已被移除' : '未知组件' }}
              </p>
              <p v-if="widget.resolved.reason === 'removed'" class="widget-missing__text">
                这个组件已不在当前版本里，但你的布局里还留着它。
              </p>
              <p v-else class="widget-missing__text">
                当前没有组件注册这个 id（<code>{{ widget.id }}</code>）。
              </p>
              <p class="widget-missing__hint">选中本框后点右上角 × 即可清掉。</p>
            </div>
          </div>
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
import PluginWidgetHost from '../widgets/PluginWidgetHost.vue'
import { resolveWidget } from '../widgets/registry'
import type { ResolvedWidget } from '../widgets/types'
import { chatThreeBoxRectsFor } from './default-layout'
import { FALLBACK_H, FALLBACK_W, canvasSize, savedRectToPercent, snapRectToGrid, toPercent, type RectUnit } from './rect'

/**
 * 面板里画的一个盒子。
 *
 * `widget` 存的是**解析结果**（`ResolvedWidget`）而不是 id：重建时要把 id 解析成
 * 「本地组件 / iframe / 占位」三者之一，而同一个 id 的答案会随插件启停而变
 * （停用时隐藏、启用时回来）。存解析结果就等于把「当前这一刻的形态」钉住 ——
 * 形态变了就重建，而不是让每个盒子自己去查一遍。
 */
type WidgetBox = { id: string; title: string; resolved: ResolvedWidget; rect: MovableBoxRect }
type PanelContainerParams = {
  widgets?: string[]
  title?: string
  layout?: Record<string, MovableBoxRect>
  /** layout 里 rect 的单位；缺省 `'px'` = 存量像素布局，新写入的都是百分比（见 rect.ts） */
  rectUnit?: RectUnit
}
const props = defineProps<{ params?: PanelContainerParams | { params?: PanelContainerParams; api?: { updateParameters?: (p: object) => void } } }>()
const resolved = computed<PanelContainerParams>(() => {
  const p = props.params as ({ params?: PanelContainerParams } & PanelContainerParams) | undefined
  return p?.params ?? p ?? {}
})
const panelApi = computed(() => (props.params as { api?: { updateParameters?: (p: object) => void } } | undefined)?.api)
const widgets = computed(() => resolved.value.widgets ?? [])
const saved = computed(() => resolved.value.layout ?? {})
/** saved rect 的单位：缺省按像素理解（老布局），`rebuild` 会顺手把它迁成百分比 */
const savedUnit = computed<RectUnit>(() => (resolved.value.rectUnit === '%' ? '%' : 'px'))
const canvas = ref<HTMLElement | null>(null)

/**
 * 工作台网格：**默认格子 20×20 px**，参照尺寸是默认工作台 1600×900（`rect.ts` 的 FALLBACK）。
 *
 * 于是横轴切 80 格、竖轴切 45 格 —— 换算成百分比是**两个不同的步长**
 * （横 `100/80 = 1.25%`、竖 `100/45 ≈ 2.222222%`），因为同一个百分比横竖代表的像素不一样。
 * 格子只有在 **16:9 画布**（= 参照尺寸）上才是正方形，其它比例会略微变长方 ——
 * 换来的是**永不漂移**：见下面「为什么刻度定义在百分比上」。
 *
 * 想更密 / 更疏只改 `CELL_PX` 这一个常量（10 = 160×90 格，25 = 64×36 格），
 * 粗线会自动保持「每 100px 一条」，不跟着格子变粗变细。
 *
 * ## 为什么刻度定义在百分比上，而不是像素
 *
 * 盒子存的就是百分比：两者同一套刻度，工作台一缩放，线跟着画布走、盒子边缘也跟着走，
 * **永远压在一起**。反过来按像素刻的话，窗口一改尺寸，盒子就整批从线上漂走了。
 * 代价是格子的**像素尺寸**只在参照尺寸上正好等于 `CELL_PX`，别的尺寸按比例变。
 */
const CELL_PX = 20
const GRID_COLS = Math.round(FALLBACK_W / CELL_PX)
const GRID_ROWS = Math.round(FALLBACK_H / CELL_PX)
const GRID_X = 100 / GRID_COLS
const GRID_Y = 100 / GRID_ROWS
/** 粗线每 100px 一条（参照尺寸上）= 每 `100/CELL_PX` 格；`max(1)` 是防格子配得比 100px 还大 */
const GRID_MAJOR = Math.max(1, Math.round(100 / CELL_PX))
/** 百分比写进 CSS 变量，留 6 位小数（2.222222% 这种），够画线用了 */
const pct = (value: number): string => `${Math.round(value * 1e6) / 1e6}%`
const gridStyle: Record<string, string> = {
  '--panel-grid-x': pct(GRID_X),
  '--panel-grid-y': pct(GRID_Y),
  '--panel-grid-major-x': pct(GRID_X * GRID_MAJOR),
  '--panel-grid-major-y': pct(GRID_Y * GRID_MAJOR),
}
/** 新盒子默认摆开的**间距（px）**：跟格子同宽，新盒子才落在格线上 */
const gridSize = CELL_PX

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

/** rect 里的值可能是 `'12%'` 这种字符串，统一当数字读；读不出来给 NaN（判定时会不相等） */
function unitValue(value: number | string | undefined): number {
  return typeof value === 'number' ? value : Number.parseFloat(value ?? '')
}

/** 按 zIndex 从底到顶排一份；缺省当 0（老布局可能没写过 zIndex） */
function orderedWidgets(): WidgetBox[] {
  return [...visible.value].sort(
    (a, b) => (unitValue(a.rect.zIndex) || 0) - (unitValue(b.rect.zIndex) || 0),
  )
}

/** 当前选中框的层级序号：1 = 最底层，越往上越大（就是输入框里显示的那个数） */
function layerOf(id: string): number {
  return orderedWidgets().findIndex((widget) => widget.id === id) + 1
}

/**
 * 输入框直接跳层。越界钳到 [1, 层数] —— 用户敲 99 和敲 9 的效果一样（顶到最上），
 * 敲 0 / 空 / 非数字则不动（`parseInt` 给 NaN 时直接返回）。
 * 换完把整叠 zIndex 归一化成 1..N，跟 `moveLayer` 保持同一套不变量。
 */
function setLayer(id: string, event: Event): void {
  const target = Number.parseInt((event.target as HTMLInputElement).value, 10)
  if (!Number.isFinite(target)) return
  const ordered = orderedWidgets()
  const from = ordered.findIndex((widget) => widget.id === id)
  if (from < 0) return
  const to = Math.min(Math.max(target, 1), ordered.length) - 1
  if (to === from) return
  const [moved] = ordered.splice(from, 1)
  ordered.splice(to, 0, moved)
  ordered.forEach((widget, index) => {
    widget.rect.zIndex = index + 1
  })
  persist()
}

/** 全屏前的原样，按 id 记着（rebuild 会重造 rect 对象，但这张表在组件里、不受影响） */
const fullscreenRestore = new Map<string, MovableBoxRect>()

function isFullscreenRect(rect: MovableBoxRect): boolean {
  return (
    unitValue(rect.left) === 0 &&
    unitValue(rect.top) === 0 &&
    unitValue(rect.width) === 100 &&
    unitValue(rect.height) === 100
  )
}

/**
 * 撑满所在工作台（画布铺满 = 四个值写成 0/0/100/100%，随工作台缩放照样满）。
 * 再点一次还原到撑满前的样子；顺手提到最上层 —— 撑满后被别的盒子压着就白撑了。
 * 面板重载后没有还原位（布局里存的本来就是撑满态）时，退回网格默认几何。
 */
function toggleFullscreen(id: string): void {
  const widget = visible.value.find((item) => item.id === id)
  if (!widget) return
  if (isFullscreenRect(widget.rect)) {
    const restore = fullscreenRestore.get(id)
    if (restore) {
      widget.rect = { ...restore }
    } else {
      const { width, height } = canvasSize(canvas.value)
      widget.rect = toPercent(defaultRect(visible.value.indexOf(widget)), width, height)
    }
    persist()
    return
  }
  const topZ = visible.value.reduce((max, item) => Math.max(max, unitValue(item.rect.zIndex) || 0), 0)
  fullscreenRestore.set(id, { ...widget.rect })
  widget.rect = { ...widget.rect, left: 0, top: 0, width: 100, height: 100, zIndex: topZ + 1 }
  persist()
}

function isSelected(id: string): boolean {
  return selectedIds.value.includes(id)
}

/**
 * 编辑态点哪儿都能选中（本地组件事件本来冒泡；插件 iframe 在编辑态一律穿透，见样式注释）。
 *
 * 这里是**选中集的唯一写者**：库那份 `update:selected` 我们故意不接（模板上是 `:selected` 单向），
 * 所以「先按 plain 点、再 Ctrl 加选」算出来的多选不会被库的收窄 emit 冲掉。
 * 注意判断读的是**自己的** `selectedIds`，不是库里那份。
 */
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
  const cols = Math.max(1, Math.floor((canvas.value?.clientWidth ?? FALLBACK_W) / (width + gridSize)))
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
  const { width, height } = canvasSize(canvas.value)
  const unit = savedUnit.value
  visible.value = widgets.value.flatMap((id, index) => {
    // 停用 / 已卸载插件的组件不渲染（停用仅隐藏，重新启用自动恢复）
    if (!pluginStore.isWidgetEnabled(id)) return []
    // 解析不出来的 id **也要画出来**（`kind: 'missing'`）：用户布局里存着的 id
    // 不会因为我们删了组件就自动消失 —— 悄悄少一个盒子，用户会以为布局坏了。
    const widget = resolveWidget(id, pluginStore.all)
    const fromSaved = saved.value[id]
    // saved > 三盒预设 > 通用网格。三者给的都是**像素**（预设/网格按当前画布量，
    // 老布局存的也是像素），统一换算成百分比交给 MovableBox：
    // 之后工作台怎么缩放，盒子的相对位置和大小都不用再管（见 rect.ts）。
    const rect = fromSaved
      ? savedRectToPercent(fromSaved, unit, width, height)
      : toPercent(presets[id] ?? defaultRect(index), width, height)
    return [{ id, title: widget.title, resolved: markRaw(widget) as ResolvedWidget, rect }]
  })
  const alive = new Set(visible.value.map((widget) => widget.id))
  selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
  migrateSavedLayout()
}

/**
 * 老布局迁移：存量 `params.layout` 是像素，就地换算成百分比并补上 `rectUnit` 标记。
 *
 * 只在格式还是 `'px'` 时做一次。写回会改 params → `watch(saved)` 再进一次 rebuild，
 * 那时标记已经是 `'%'`，自然停手（不会来回写）。
 * 独立面板窗没有 panelApi —— 迁不了也用不上，它的 layout 本来就不落盘。
 */
function migrateSavedLayout(): void {
  const entries = Object.entries(saved.value)
  if (savedUnit.value === '%' || entries.length === 0) return
  if (!panelApi.value?.updateParameters) return
  const { width, height } = canvasSize(canvas.value)
  panelApi.value.updateParameters({
    rectUnit: '%',
    layout: Object.fromEntries(entries.map(([id, rect]) => [id, toPercent(rect, width, height)])),
  })
}

const snapTargets = computed(() => visible.value.map((widget) => ({ ...widget.rect, id: widget.id })))

function writeWidgets(nextWidgets: string[], nextVisible: WidgetBox[] = visible.value): void {
  panelApi.value?.updateParameters?.({
    widgets: nextWidgets,
    // 统一按百分比落盘：MovableBox 跑在 unit-type="%" 下，update:modelValue 给的就是百分比，
    // 直接存即可。rectUnit 是给下一次 rebuild 读的格式标记（缺省按像素理解老布局）。
    rectUnit: '%',
    layout: Object.fromEntries(nextVisible.map((widget) => [widget.id, widget.rect])),
  })
  window.dispatchEvent(new CustomEvent('osteosome:panel-layout'))
}

function persist(): void {
  writeWidgets(widgets.value)
}

/**
 * 松手（拖完 / 缩完）把盒子收进网格。
 *
 * 库自带的 `snapToGrid` **没开**：它横竖共用一个步长，而我们的格子横竖刻度不同
 * （20px 格子在百分比里 = 横 1.25%、竖 2.222222%），用它吸出来的格子是长方形，
 * 跟背景画的线对不上。所以吸附统一在松手时自己做，四条边一起收口 ——
 * 拖动过程中只有「与其它盒子对齐」的参考线（snapToElements）在实时给反馈。
 */
function onInteractionStop(widget: WidgetBox): void {
  widget.rect = snapRectToGrid(widget.rect, GRID_X, GRID_Y)
  persist()
}

/**
 * 整组移动松手：把**这一组选中的盒子**一起收进网格。
 *
 * 多选拖动时被拖的只是其中一个，其余跟着整体位移 —— 只收被拖的那一个，
 * 组内的相对位置会差出那半格，整组看着就歪了。位移量大家一样，
 * 收口时各收各的即可（吸附是幂等的，与 drag-stop 先后顺序无关）。
 */
function onMoveStop(): void {
  for (const widget of visible.value) {
    if (selectedIds.value.includes(widget.id)) widget.rect = snapRectToGrid(widget.rect, GRID_X, GRID_Y)
  }
  persist()
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
/*
 * 工作台网格线：只画在**编辑态**（运行态是正常用的界面，不该飘着辅助线）。
 *
 * 四层背景：前两层是**粗线**（每 100px 一条的大方格），后两层是**细线**
 * （默认格子 20×20px），粗的压在细的上面。
 *
 * 格子密（横 80 + 竖 45 条细线），所以细线要压得很淡，粗线才是主要参照 —— 否则整屏都是墨。
 *
 * 关键在 `background-size` 用**百分比**：网格和盒子的百分比坐标是同一套刻度，
 * 工作台缩放时线跟着画布走、盒子边缘也跟着走，谁也不会漂离谁。
 * 步长从模板的 `gridStyle` 注入（`GRID_X` / `GRID_Y` 是唯一真源），改粒度只改那一处。
 */
.panel-boxes--edit .panel-boxes__canvas {
  background-image:
    linear-gradient(to right, var(--color-border-strong) 1px, transparent 1px),
    linear-gradient(to bottom, var(--color-border-strong) 1px, transparent 1px),
    linear-gradient(to right, color-mix(in srgb, var(--color-border) 38%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-border) 38%, transparent) 1px, transparent 1px);
  background-size:
    var(--panel-grid-major-x) var(--panel-grid-major-y),
    var(--panel-grid-major-x) var(--panel-grid-major-y),
    var(--panel-grid-x) var(--panel-grid-y),
    var(--panel-grid-x) var(--panel-grid-y);
}
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
/* 层级输入框：34px 宽刚好够两位数，去掉增减箭头（那两个箭头占掉大半个框，误点就跳层） */
.panel-boxes__layer-input {
  flex: none;
  width: 34px;
  height: 16px;
  padding: 0 2px;
  border: 1px solid var(--color-topbar-overlay-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-topbar-text);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  text-align: center;
  -moz-appearance: textfield;
  appearance: textfield;
}
.panel-boxes__layer-input::-webkit-outer-spin-button,
.panel-boxes__layer-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.panel-boxes__layer-input:focus { outline: none; border-color: var(--color-primary); background: var(--color-topbar-overlay); }
/*
 * 缩放把手：库里默认是白底圆点（10px + 2px currentColor 描边），原来被整条 opacity:0 藏掉了。
 * 现在只给**选中**的盒子露出来 —— 八个点跟着选中态走，不选中时不糊满整屏；
 * 未选中的盒子热区仍在（opacity:0 照样吃指针），点一下选中、点边缘就能缩放。
 */
.panel-boxes__item :deep(.handle) { opacity: 0; }
.panel-boxes--edit .panel-boxes__item--selected :deep(.handle) { opacity: 1; }
/*
 * 编辑态一律穿透：插件内容是 iframe，指针事件进去就出不来。
 *
 * 「未选中穿透、选中放开」看着周全，实际代价是**选中的盒子正文拖不动** ——
 * 选中那一刻 pointer-events 变回 auto，再抓正文命中的是 iframe，drag 根本不启动，
 * 用户的体感就是「这个组件不吸网格」（实际是压根没在动）。
 * 顺带多选拖动也会整组失灵：被拖的那个正是选中态。
 *
 * 所以编辑态**从头到尾**都不给 iframe 指针：点哪都是选中/拖动/缩放，
 * 网格吸附（drag-stop / resize-stop）才随时可用。
 * 要点组件内容就切运行态 —— 编辑态是排版用的，运行态才是用的。
 * （本地组件不走这条：它的 DOM 事件本来就冒泡。）
 */
.panel-boxes--edit .panel-boxes__body :deep(.plugin-host__frame) { pointer-events: none; }
.panel-boxes__body { flex: 1; min-height: 0; overflow: auto; padding: var(--space-3); }
/* 组件内容自适应：内容根节点至少撑满盒子，随盒子缩放自适应；超出部分在盒内滚动 */
.panel-boxes__body > :deep(*) { min-height: 100%; }
.panel-boxes__empty { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
/* 已移除/未知组件的占位：与正常组件同尺寸同可拖动（用户要能把它拖走，也能直接删） */
.widget-missing { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-4); text-align: center; color: var(--color-text-muted); }
.widget-missing__title { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--color-text); }
.widget-missing__text { margin: 0; font-size: var(--text-xs); line-height: 1.5; }
.widget-missing__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-subtle, var(--color-text-muted)); }
</style>
