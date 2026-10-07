/**
 * 会话级运行态投影（P4b P0-14）—— 一串 `loop.*` 事件 → 每个会话一个 motion。
 *
 * ## 它为什么存在
 *
 * `sending` 是**每个 iframe 各自**的本地派生量，只回答「我这个盒子在跑吗」。
 * 三个盒子都开着时，用户**无法知道是哪个会话在跑**。而 `loop.*` 每一条都带 `sessionId`
 * —— 数据早就在事件里，只是没人拿它画东西。这一层把它投影成 `Map<sessionId, MotionState>`。
 *
 * ## 两条硬规矩（P4b §3 P0-14 的红线）
 *
 * ① **不为画一个点临时订阅新 topic**。`sse.subscribe()` 遇到之前没订阅过的 topic 会
 *    `reconnect()` —— 旧流已关、新流未开，缝里发出的命令没有回音（`state/session.ts:183`
 *    记着这个坑，踩过两次）。所以这里订阅的 topic **集合固定**，且由列表视图在
 *    `bootstrap()` 时**一次绑好**（不在任何命令路径上）。
 *
 * ② **只在 ① 这个视图里算**。三个 iframe 各算一份 = 内存与 CPU ×3，而只有侧栏需要它。
 *    投影是**纯函数**：同样的事件序列永远得到同样的 motion，与谁在算无关。
 *
 * ## 投影表（§4）
 *
 * | 事件 | motion |
 * |---|---|
 * | `loop.state.changed{running}` | thinking |
 * | `loop.tool.executed` | working |
 * | `loop.token.streamed{blockType≠reasoning}` | speaking |
 * | `loop.token.streamed{blockType=reasoning}` | 保持 thinking（思考是 speaking 的前身） |
 * | `loop.state.changed{idle}`（无失败） | success |
 * | `loop.run.failed` | error（留住，直到下一次 running） |
 * | `loop.run.cancelled` | idle |
 */
import { reactive } from 'vue'
import { sse } from '@osteosome/core-client'
import type { MotionState } from '@osteosome/ui'

export interface SessionMotion {
  /** 读某会话当前 motion（缺省 idle） */
  motionOf: (sessionId: string) => MotionState
  /** 绑事件（幂等；在列表视图 bootstrap 时调一次） */
  bind: () => void
  dispose: () => void
}

export function useSessionMotion(): SessionMotion {
  const motions = reactive<Record<string, MotionState>>({})
  let unsubs: Array<() => void> = []

  const set = (sessionId: string, m: MotionState): void => {
    motions[sessionId] = m
  }

  function bind(): void {
    if (unsubs.length > 0) return
    unsubs = [
      sse.subscribe('loop.state.changed', (payload) => {
        const p = payload as { sessionId?: string; state?: string }
        if (!p?.sessionId) return
        if (p.state === 'running') set(p.sessionId, 'thinking')
        else if (p.state === 'idle' && motions[p.sessionId] !== 'error') set(p.sessionId, 'success')
      }),
      sse.subscribe('loop.token.streamed', (payload) => {
        const p = payload as { sessionId?: string; blockType?: string }
        if (!p?.sessionId) return
        // reasoning 是 thinking 的延续，不改动；正文 token 才进 speaking
        if (p.blockType !== 'reasoning') set(p.sessionId, 'speaking')
      }),
      sse.subscribe('loop.tool.executed', (payload) => {
        const p = payload as { sessionId?: string }
        if (!p?.sessionId) return
        set(p.sessionId, 'working')
      }),
      sse.subscribe('loop.run.failed', (payload) => {
        const p = payload as { sessionId?: string }
        if (!p?.sessionId) return
        set(p.sessionId, 'error')
      }),
      sse.subscribe('loop.run.cancelled', (payload) => {
        const p = payload as { sessionId?: string }
        if (!p?.sessionId) return
        set(p.sessionId, 'idle')
      }),
    ]
  }

  return {
    motionOf: (sessionId) => (sessionId ? (motions[sessionId] ?? 'idle') : 'idle'),
    bind,
    dispose: () => {
      for (const off of unsubs) off()
      unsubs = []
    },
  }
}
