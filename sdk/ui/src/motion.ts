/**
 * 运行态 motion 枚举（P4b 会话列表重设计 §4）—— `StatusDot` / `Badge` 共用。
 *
 * 它**不是** loop 事件类型，而是「一行会话当前在干什么」的用途枚举：
 * 视图层把 `loop.*` 事件投影成它，组件层把它画成颜色 + 脉动。
 * 放这里（而不是某个 .vue 里）是因为 .vue 的命名导出对 vue-tsc 不够可靠，
 * 而两个组件的 props 都需要这个联合类型。
 */
export type MotionState =
  | 'idle'
  | 'thinking'
  | 'listening'
  | 'working'
  | 'speaking'
  | 'success'
  | 'error'

/** 会脉动的四种（正在进行的轮次）；终态与 idle 静置 —— 与 StatusDot 的 CSS 一致 */
export const PULSING_MOTIONS: readonly MotionState[] = ['thinking', 'listening', 'working', 'speaking']

/** 中文标签（无障碍 + 悬停文案的唯一一份） */
export const MOTION_LABEL: Record<MotionState, string> = {
  idle: '空闲',
  thinking: '思考中',
  listening: '等待确认',
  working: '执行工具',
  speaking: '回复中',
  success: '已完成',
  error: '出错',
}
