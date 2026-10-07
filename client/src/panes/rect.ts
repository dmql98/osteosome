/**
 * 盒子几何的**单位换算**（相对化）。
 *
 * ## 为什么要相对化
 *
 * `MovableBox` 的 rect 以前存的是**绝对像素**：拖完把 `{left,top,width,height}` 落到
 * `params.layout`。工作台一变大变小，像素还是那些像素 —— 盒子既不跟着铺满，
 * 也不会被推出可视区，看起来就是「布局和窗口脱钩了」。
 *
 * 改成**画布宽高的百分比**之后，几何本身是不变量：窗口怎么缩放，
 * 盒子在工作台里的相对位置和大小都一样（CSS `left/width` 直接吃百分比）。
 *
 * ## 单位由 MovableBox 自己认
 *
 * 配合 `unit-type="%"`，`vue-movable-box` 的**模型值就是百分比**：
 * 渲染直接 `${value}%`，拖拽时用 `parentWidth / 100` 把指针位移换算进模型。
 * 所以我们只需要在**落盘的那一刻**做一次像素 → 百分比，运行期不用自己监听 resize。
 *
 * ## 老布局怎么办
 *
 * `params.rectUnit` 是格式标记：缺省 `'px'` = P6 及以前的老布局（存量像素值），
 * `PanelContainer` 读到它会**按像素理解 saved rect 并就地换算**，然后把标记写回 `'%'`。
 * 标记缺失不影响渲染 —— 渲染始终吃百分比，缺的只是「saved 到底是什么单位」的解释。
 */
import type { MovableBoxRect } from 'vue-movable-box'

/** `params.layout` 里 rect 的单位：`'%'` = 新格式（相对画布），`'px'` = 存量像素布局 */
export type RectUnit = 'px' | '%'

/**
 * 默认工作台尺寸（px）。
 *
 * 量不到画布时的兜底（jsdom / 隐藏容器 / 首帧），同时也是**网格和默认几何的参照尺寸**：
 * 网格按它切成 20×20 的格子（见 `PanelContainer.GRID_*`），1600×900 上正好 80×45 格。
 */
export const FALLBACK_W = 1600
export const FALLBACK_H = 900

/** 取画布尺寸；量不到（0 / null）就退回兜底值，绝不让换算分母变成 0 */
export function canvasSize(element: { clientWidth?: number; clientHeight?: number } | null): {
  width: number
  height: number
} {
  return {
    width: element?.clientWidth || FALLBACK_W,
    height: element?.clientHeight || FALLBACK_H,
  }
}

/** rect 里的值可能是 number 也可能是 `'240'` 这种字符串，统一按数字读 */
function value(v: string | number | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const parsed = Number.parseFloat(v ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** 保留 4 位小数：足够精确（900px 画布上 0.01% ≈ 1px），又不至于把 JSON 撑长 */
function round(percent: number): number {
  return Math.round(percent * 1e4) / 1e4
}

/**
 * 像素 rect → 百分比 rect。
 *
 * 负数一律钳到 0（拖拽越界、历史脏数据都可能产生），超过 100 钳到 100：
 * 百分比超过 100 就意味着盒子跑出画布，渲染出来是一坨点不回来的溢出。
 * `zIndex` 不带单位，原样保留。
 */
export function toPercent(rect: MovableBoxRect, width: number, height: number): MovableBoxRect {
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  const clamp = (percent: number): number => round(Math.min(100, Math.max(0, percent)))
  return {
    left: clamp((value(rect.left) / w) * 100),
    top: clamp((value(rect.top) / h) * 100),
    width: clamp((value(rect.width) / w) * 100),
    height: clamp((value(rect.height) / h) * 100),
    zIndex: rect.zIndex,
  }
}

/**
 * 把百分比 rect **吸附到网格**（横竖各自的值收到各自步长的整数倍）。
 *
 * 横竖**分开两个步长**是必须的：格子在参照尺寸上是**正方形**（1600×900 切 20px 格子，
 * 横 80 格、竖 45 格），但盒子存的是百分比 —— 同一个百分比横竖代表的像素不一样
 * （1.25% 在横轴是 20px，在竖轴只有 11.25px），用一个步长的话格子就变成长方形，
 * 视觉上的网格线也就对不上了。
 *
 * 拖动时 `MovableBox` 自带的 `snapToGrid` 只吃**一个**步长（见其 `gridSize`），
 * 所以那边干脆不开 —— 吸附统一在**松手时**由这里收口（drag-stop / resize-stop）。
 * 这样四条边一起进网格：左压线而右不压，等于没对齐。
 *
 * 次序是**先量宽高、再收位置**：`left` 最多只能到 `100 - width`，否则盒子右边会出画布。
 * 步长配错（<=0 / 非数）时原样返回 —— 吸附失败不该把布局弄坏。
 */
export function snapRectToGrid(rect: MovableBoxRect, stepX: number, stepY: number): MovableBoxRect {
  if (![stepX, stepY].every((step) => Number.isFinite(step) && step > 0)) return rect
  const snap = (v: string | number | undefined, step: number): number =>
    round(Math.round(value(v) / step) * step)
  const width = Math.min(100, Math.max(stepX, snap(rect.width, stepX)))
  const height = Math.min(100, Math.max(stepY, snap(rect.height, stepY)))
  const left = Math.min(100 - width, Math.max(0, snap(rect.left, stepX)))
  const top = Math.min(100 - height, Math.max(0, snap(rect.top, stepY)))
  return { left, top, width, height, zIndex: rect.zIndex }
}

/**
 * 解析一份 saved rect：已经是百分比就原样用，是像素（老布局）先换算。
 *
 * 把「解释 saved 的单位」这一件事收在一处 —— PanelContainer.rebuild 每个盒子都要走，
 * 分散写判断漏一个就是「某个盒子突然跑出屏幕」。
 */
export function savedRectToPercent(
  rect: MovableBoxRect,
  unit: RectUnit,
  width: number,
  height: number,
): MovableBoxRect {
  return unit === '%' ? rect : toPercent(rect, width, height)
}
