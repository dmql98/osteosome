/**
 * loop 状态机核心（P3 WS-3）—— 与 Service 装配解耦的纯逻辑，单测直测。
 *
 * 职责（P3 §3.4 + WS-3）：
 * - **requestId 分层**：A = `loop.run` 的（驱动 loop.state.changed / loop.run.failed / loop.run.cancelled，
 *   前端只见 A）；B = loop 发 `llm.request` 时的内部 id（llm 事件全带 B）；A↔B 映射只活在 loop 内存，不泄前端。
 * - **状态机**：idle ⇄ running；running 中重复 run → 拒绝（`busy`）。
 * - **in-flight 累积**：assistant 全文驻 loop 内存（不落库，finish 时才 append）。
 */
import type { Usage } from '@osteosome/shared'

export type LoopState = 'idle' | 'running'

export interface Inflight {
  /** loop.run 的 A（对外） */
  a: string
  /** llm.request 的 B（对内） */
  b: string
  sessionId: string
  /** 累积的 assistant 全文（finish 时落库） */
  buffer: string
}

export interface LoopCoreDeps {
  /** 发送 llm.request（B） */
  sendLlmRequest(b: string, sessionId: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[], model?: string): void
  /** 发送 llm.cancel（B） */
  sendLlmCancel(b: string): void
}

export class LoopCore {
  private state: LoopState = 'idle'
  private readonly byA = new Map<string, Inflight>()
  private readonly aByB = new Map<string, string>()

  constructor(private readonly deps: LoopCoreDeps) {}

  currentState(): LoopState {
    return this.state
  }

  isBusy(): boolean {
    return this.state === 'running'
  }

  /**
   * 启动一次 run（A）：查重入 → 记 A↔B in-flight → 发 llm.request（B）。
   * 返回 false 表示重入被拒（调用方发 loop.run.failed{code:'busy'}）。
   */
  start(
    a: string,
    b: string,
    sessionId: string,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    model?: string,
  ): boolean {
    if (this.isBusy()) return false
    this.state = 'running'
    this.byA.set(a, { a, b, sessionId, buffer: '' })
    this.aByB.set(b, a)
    this.deps.sendLlmRequest(b, sessionId, messages, model)
    return true
  }

  /** llm.token.streamed（B）→ 累积到 in-flight buffer；返回对外 A（供转发 loop.token.streamed） */
  onToken(b: string, token: string): string | null {
    const a = this.aByB.get(b)
    if (!a) return null
    const inflight = this.byA.get(a)
    if (!inflight) return null
    inflight.buffer += token
    return a
  }

  /**
   * llm.request.finished（B）→ 取 A + 累积全文 + 释放；返回收尾信息（调用方 message.append + state.changed idle）。
   * 已结束/未知 B → null（不串号）。
   */
  finish(b: string, finishReason: string, usage?: Usage): { a: string; sessionId: string; content: string; finishReason: string; usage?: Usage } | null {
    const a = this.aByB.get(b)
    if (!a) return null
    const inflight = this.byA.get(a)
    if (!inflight) return null
    const out = { a, sessionId: inflight.sessionId, content: inflight.buffer, finishReason, ...(usage ? { usage } : {}) }
    this.release(a)
    return out
  }

  /** loop.cancel（A）→ 查 B 并发 llm.cancel(B)；未知 A 静默。返回是否发出取消。 */
  cancel(a: string): boolean {
    const inflight = this.byA.get(a)
    if (!inflight) return false
    this.deps.sendLlmCancel(inflight.b)
    return true
  }

  /**
   * 取消收尾（A）：不落半截 assistant（P3 §3.4 成功路径不留痕），释放并回 idle。
   * 未知 A → false。
   */
  cancelFinish(a: string): { a: string; sessionId: string } | null {
    const inflight = this.byA.get(a)
    if (!inflight) return null
    const out = { a, sessionId: inflight.sessionId }
    this.release(a)
    return out
  }

  /**
   * llm.request.failed（B）→ 取 A + 释放；返回收尾信息（调用方 loop.run.failed(A)，不落 assistant）。
   */
  fail(b: string): { a: string; sessionId: string } | null {
    const a = this.aByB.get(b)
    if (!a) return null
    const inflight = this.byA.get(a)
    if (!inflight) return null
    const out = { a, sessionId: inflight.sessionId }
    this.release(a)
    return out
  }

  /** 释放一次 run（state 回 idle，映射清理） */
  private release(a: string): void {
    const inflight = this.byA.get(a)
    this.byA.delete(a)
    if (inflight) this.aByB.delete(inflight.b)
    this.state = 'idle'
  }

  /** 崩溃恢复（P3 WS-5）：进程重启后 in-flight 归零、state 回 idle（进程内态，无回放） */
  reset(): void {
    this.byA.clear()
    this.aByB.clear()
    this.state = 'idle'
  }
}
