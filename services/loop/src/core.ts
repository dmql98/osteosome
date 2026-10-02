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

/** 一轮请求的消息（中立 ChatMessage 形状，`buildMessages` 产出） */
export type ChatTurn = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

export interface Inflight {
  /** loop.run 的 A（对外） */
  a: string
  /** llm.request 的 B（对内） */
  b: string
  sessionId: string
  /** 累积的 assistant 正文（finish 时落库）；**不含思维链** */
  buffer: string
  /** 累积的思维链（S4）。与 `buffer` 分开，正文里不许出现它 */
  reasoningBuffer: string
}

export interface LoopCoreDeps {
  /** 发送 llm.request（B） */
  sendLlmRequest(b: string, sessionId: string, messages: ChatTurn[], model?: string): void
  /** 发送 llm.cancel（B） */
  sendLlmCancel(b: string): void
}

/**
 * 一次 run 的两阶段状态（多轮接线）：
 *
 * - `accept(A, sessionId, text)` —— 受理 loop.run：查重入 → 进入 `awaiting`（已占位防重入），
 *   返回 true/false（false=忙）。此时**尚未**发 llm.request。
 * - `start(B, messages)` —— 拿到 session.get.result 拼好多轮后调用：记 A↔B in-flight → 发 llm.request(B)。
 *
 * 消息驱动模型下「拉历史」是一次总线往返（A 先占位 → 装配层订阅 session.get.result → 再 start），
 * 因此 A→B 的映射在 start(B) 时才建立。
 */
export class LoopCore {
  private state: LoopState = 'idle'
  private readonly byA = new Map<string, Inflight>()
  private readonly aByB = new Map<string, string>()
  /** 已受理但等 session.get.result 的 A（占位防重入，尚未发 llm.request） */
  private awaiting: { a: string; sessionId: string; text: string } | null = null

  constructor(private readonly deps: LoopCoreDeps) {}

  currentState(): LoopState {
    return this.state
  }

  isBusy(): boolean {
    return this.state === 'running'
  }

  /**
   * 受理一次 loop.run（A）：查重入 → 进入 awaiting（占位）→ 返回 true。
   * 返回 false 表示重入被拒（调用方发 loop.run.failed{code:'busy'}）。
   * 调用方随后发 session.get，拿到 result 再 start(B, messages)。
   */
  accept(a: string, sessionId: string, text: string): boolean {
    if (this.isBusy()) return false
    this.state = 'running'
    this.awaiting = { a, sessionId, text }
    return true
  }

  /** 当前 awaiting 的 A / sessionId（装配层据此关联 session.get 往返） */
  awaitingRun(): { a: string; sessionId: string; text: string } | null {
    return this.awaiting
  }

  /**
   * 拿到历史后启动（A 已 accept）：记 A↔B in-flight → 发 llm.request(B)。
   * 返回 false 表示已无 awaiting（重复/已取消）。
   */
  start(
    b: string,
    messages: ChatTurn[],
    model?: string,
  ): boolean {
    if (!this.awaiting) return false
    const { a, sessionId } = this.awaiting
    this.awaiting = null
    this.byA.set(a, { a, b, sessionId, buffer: '', reasoningBuffer: '' })
    this.aByB.set(b, a)
    this.deps.sendLlmRequest(b, sessionId, messages, model)
    return true
  }

  /** 直接启动（无 awaiting 的快路径，单测/不需要历史的场景） */
  startNow(
    a: string,
    b: string,
    sessionId: string,
    messages: ChatTurn[],
    model?: string,
  ): boolean {
    if (this.isBusy()) return false
    this.state = 'running'
    this.byA.set(a, { a, b, sessionId, buffer: '', reasoningBuffer: '' })
    this.aByB.set(b, a)
    this.deps.sendLlmRequest(b, sessionId, messages, model)
    return true
  }

  /** 当前 B 对应的对外 A（工具轮编排需要先拿 A 才能发 loop.tool.executed；未知返回 null） */
  currentA(b: string): string | null {
    return this.aByB.get(b) ?? null
  }

  /** 读本轮已累积的 assistant 全文（工具轮：发消息前先看一眼，**不清空**） */
  peekContent(b: string): string {
    return this.peek(b).content
  }

  /** 本轮正文 + 思维链（工具轮 append 用；S4） */
  peek(b: string): { content: string; reasoning: string } {
    const a = this.aByB.get(b)
    if (!a) return { content: '', reasoning: '' }
    const inflight = this.byA.get(a)
    if (!inflight) return { content: '', reasoning: '' }
    return { content: inflight.buffer, reasoning: inflight.reasoningBuffer }
  }

  /**
   * 工具轮续跑（P7）：`llm.request.finished{finishReason:'tool_calls'}` 时**不结束 run**。
   *
   * - 取回旧 B 对应的 A 与本轮 assistant 正文 + 思维链（由调用方 append 到会话）；
   * - 把 A↔新 B 的映射换掉、清空两个 buffer（下一轮从零累积）；
   * - 发出新一轮 `llm.request`；**state 保持 running**（`loop.state.changed` 不发 idle）。
   *
   * 返回 `null` 表示旧 B 未知/已释放（重复事件、取消后迟到）——调用方应静默忽略。
   */
  nextRound(
    oldB: string,
    newB: string,
    messages: ChatTurn[],
    model?: string,
  ): { a: string; sessionId: string; content: string; reasoning: string } | null {
    const a = this.aByB.get(oldB)
    if (!a) return null
    const inflight = this.byA.get(a)
    if (!inflight) return null
    const content = inflight.buffer
    const reasoning = inflight.reasoningBuffer
    this.aByB.delete(oldB)
    inflight.b = newB
    inflight.buffer = ''
    inflight.reasoningBuffer = ''
    this.aByB.set(newB, a)
    this.deps.sendLlmRequest(newB, inflight.sessionId, messages, model)
    return { a, sessionId: inflight.sessionId, content, reasoning }
  }

  /**
   * `llm.token.streamed`（B）→ **按块类型分流**累积；返回对外 A（供转发 `loop.token.streamed`）。
   *
   * S4：`blockType === 'reasoning'` 的 token 进 `reasoningBuffer`，**不进 `buffer`**。
   * 缺省按 `'text'` 处理 —— 老版本节点不发这个字段，不能因为缺字段就把正文丢掉。
   */
  onToken(b: string, token: string, blockType: 'text' | 'reasoning' = 'text'): string | null {
    const a = this.aByB.get(b)
    if (!a) return null
    const inflight = this.byA.get(a)
    if (!inflight) return null
    if (blockType === 'reasoning') inflight.reasoningBuffer += token
    else inflight.buffer += token
    return a
  }

  /**
   * `llm.request.finished`（B）→ 取 A + 累积正文 + 释放；返回收尾信息（调用方 message.append + state.changed idle）。
   * 已结束/未知 B → null（不串号）。
   *
   * `reasoning` 单独返回（S4）：调用方落库到 `Message.reasoning`，正文 `content` 里不含它。
   */
  finish(
    b: string,
    finishReason: string,
    usage?: Usage,
  ): { a: string; sessionId: string; content: string; reasoning: string; finishReason: string; usage?: Usage } | null {
    const a = this.aByB.get(b)
    if (!a) return null
    const inflight = this.byA.get(a)
    if (!inflight) return null
    const out = {
      a,
      sessionId: inflight.sessionId,
      content: inflight.buffer,
      reasoning: inflight.reasoningBuffer,
      finishReason,
      ...(usage ? { usage } : {}),
    }
    this.release(a)
    return out
  }

  /**
   * loop.cancel（A）：在途（已 start）→ 发 llm.cancel(B)；awaiting（等历史）→ 直接丢弃占位（还没发 llm.request）。
   * 未知 A 静默。返回是否需要发 llm.cancel（awaiting 场景返回 false 但已清占位）。
   */
  cancel(a: string): boolean {
    // awaiting 阶段：还没发 llm.request，直接清占位回 idle
    if (this.awaiting?.a === a) {
      this.awaiting = null
      this.state = 'idle'
      return false
    }
    const inflight = this.byA.get(a)
    if (!inflight) return false
    this.deps.sendLlmCancel(inflight.b)
    return true
  }

  /** awaiting 阶段取消收尾（A）：清占位回 idle，返回 sessionId 供发 loop.run.cancelled */
  cancelAwaiting(a: string): { a: string; sessionId: string } | null {
    if (this.awaiting?.a !== a) return null
    const out = { a, sessionId: this.awaiting.sessionId }
    this.awaiting = null
    this.state = 'idle'
    return out
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

  /** 崩溃恢复（P3 WS-5）：进程重启后 in-flight / awaiting 归零、state 回 idle（进程内态，无回放） */
  reset(): void {
    this.byA.clear()
    this.aByB.clear()
    this.awaiting = null
    this.state = 'idle'
  }
}
