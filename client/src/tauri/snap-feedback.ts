/**
 * 吸附反馈：Rust 壳（src-tauri/src/lib.rs）在贴边瞬间 emit `ost:window-snap`，
 * 这里收到后在该窗口贴边处播放一次高亮脉冲。
 * 事件名与边名需与 lib.rs 的 SNAP_EVENT / Side::edges 保持一致。
 */
import { isTauri } from './plugin-window'

const EVENT = 'ost:window-snap'
const CLASS = 'snap-pulse'

let started = false

/** 每个窗口启动时调用一次；非 Tauri 环境（浏览器 / 单测）直接跳过。 */
export async function initSnapFeedback(): Promise<void> {
  if (started || !isTauri()) return
  started = true
  const root = document.documentElement
  root.addEventListener('animationend', (event) => {
    // 动画事件会冒泡，按名字过滤；关键帧名与类名一致（见 styles/base.css）
    if (event.animationName === CLASS) root.classList.remove(CLASS)
  })
  const { listen } = await import('@tauri-apps/api/event')
  await listen<string>(EVENT, (event) => pulse(event.payload))
}

function pulse(edge: string): void {
  const root = document.documentElement
  root.dataset.snapEdge = edge
  root.classList.remove(CLASS)
  void root.offsetWidth // 强制重排，让连续吸附也能重放动画
  root.classList.add(CLASS)
}
