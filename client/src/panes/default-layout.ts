/**
 * 对话布局预设（S6）—— 打开即是《对话界面架构》§1.4 的三盒样子。
 *
 * ## 为什么不改成 CSS grid
 *
 * 面板容器 `PanelContainer` 用的是 **MovableBox 自由浮动盒子**（绝对定位 + 保存的 rect）。
 * 所以「三盒几何」的正确做法是给这三个 widget **预设初始 rect**，而不是换布局引擎 ——
 * 这样「三个盒子可各自拖动」的能力天然保留，改动面也只在初始值。
 *
 * ## 尺寸从画布现算，不写死像素
 *
 * 会话列与输入区是固定值（计划定的 240 / 120），对话区是 **flex**（占满剩余）。
 * 绝对定位没有 flex，所以 flex 那部分在**首次渲染时按当前画布尺寸换算**成像素。
 * 用户拖过之后以保存的 rect 为准 —— 那是用户的选择，不该被覆盖。
 *
 * ## 极小窗口
 *
 * 本轮明确不做「窄窗降级」（计划 §不做清单），所以这里只保证**不出负数**：
 * 固定值装不下时按比例收缩，最差退化成可用但不好看的布局，而不是溢出或抛错。
 */
import type { DockviewApi } from 'dockview-core'
import type { MovableBoxRect } from 'vue-movable-box'
import { defaultWidgetIds } from '../widgets/registry'
import { PANEL_COMPONENT } from './types'

/** 三盒的 widget id（① 会话列表 / ② 对话 / ③ 输入） */
export const CHAT_BOX = {
  sessions: 'widget.session-list',
  timeline: 'widget.chat-timeline',
  composer: 'widget.chat-composer',
} as const

/** 几何常量（对齐计划：会话 240px 固定、对话 flex、输入 120px 固定） */
const GAP = 8
const SESSION_W = 240
const COMPOSER_H = 120
/** 兜底画布尺寸：首次渲染量不到（jsdom / 隐藏容器）时按这个算，不至于全是 0 */
const FALLBACK_W = 1080
const FALLBACK_H = 720

/**
 * 三盒初始几何。
 *
 * ```
 * ┌────────┬──────────────────┐
 * │        │                  │
 * │ ①会话  │ ② 对话（flex）   │   满高 − 输入区
 * │  240px │                  │
 * ├────────┴──────────────────┤
 * │ ③ 输入（120px）            │
 * └───────────────────────────┘
 * ```
 */
export function chatThreeBoxRects(width: number, height: number): Record<string, MovableBoxRect> {
  // 只防非正数（量不到 0 的情况由 chatThreeBoxRectsFor 的兜底值处理）。
  // 这里**不能**设下限：设了下限，窄画布算出的右栏会超出画布右边 —— 第一版就是这么写错的，
  // 被「窄画布不溢出」那条用例当场抓到。
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)

  // 装不下就按比例收缩（保证两列都不为负）
  const sessionW = Math.min(SESSION_W, Math.max(0, Math.round(w * 0.35)))
  const composerH = Math.min(COMPOSER_H, Math.max(0, h - GAP * 3))

  const rightLeft = GAP + sessionW + GAP
  const rightW = Math.max(0, w - rightLeft - GAP)
  const bodyH = Math.max(0, h - composerH - GAP * 3)

  return {
    [CHAT_BOX.sessions]: { left: GAP, top: GAP, width: sessionW, height: Math.max(0, h - GAP * 2), zIndex: 1 },
    [CHAT_BOX.timeline]: { left: rightLeft, top: GAP, width: rightW, height: bodyH, zIndex: 2 },
    [CHAT_BOX.composer]: { left: rightLeft, top: GAP + bodyH + GAP, width: rightW, height: composerH, zIndex: 3 },
  }
}

/** 当前画布尺寸下的三盒几何（量不到时用兜底值） */
export function chatThreeBoxRectsFor(element: { clientWidth?: number; clientHeight?: number } | null): Record<
  string,
  MovableBoxRect
> {
  return chatThreeBoxRects(element?.clientWidth || FALLBACK_W, element?.clientHeight || FALLBACK_H)
}

/** 无持久化布局时，用 dockview 原生 addPanel 铺一个承载默认组件的面板 */
export function applyDefaultLayout(api: DockviewApi): void {
  api.addPanel({
    id: 'panel.main',
    component: PANEL_COMPONENT,
    title: '工作台',
    params: { widgets: defaultWidgetIds() },
  })
}
