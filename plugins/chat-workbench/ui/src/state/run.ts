/**
 * 一轮对话的在途状态 —— **从 SSE 派生**，不靠本地乐观行（P6）。
 *
 * ## 最大的改动：in-flight 行不再由发送方「乐观」造出来
 *
 * 原来（同一个 JS 上下文）发送方点一下就本地造两行：
 * `local-user-<A>` 与 `in-flight-<A>`，然后把流式 token 灌进第二行。
 * 这么做是因为**时间线与输入框共享同一个 store**，本地造一行它立刻就看得见。
 *
 * 拆成两个 iframe 之后这条路断了：③ 造的行 ② 看不见。
 * 而**正确的做法本来就不是乐观** —— 服务端事件已经把该说的都说了：
 *
 * | 行 | 现在靠什么出现 |
 * |---|---|
 * | user 行 | loop 一收到 `loop.run` 就发 `message.append` → session 落库 → SSE `message.appended` |
 * | assistant 占位行 | `loop.state.changed{state:'running'}` |
 * | 正文累积 | `loop.token.streamed`（按 `blockType` 分流 reasoning） |
 * | 工具卡 | `loop.tool.executed` |
 * | 收尾换 id | `message.appended`（assistant）—— 用服务端 id 换掉占位 id |
 *
 * 于是每个 iframe 只做同一件事：**按事件拼出自己那份视图**。
 * 三份视图内容必然一致，因为输入是同一批事件。
 *
 * ## 为什么这比乐观行更好，而不只是「一样好」
 *
 * 乐观行的固有代价是**它可能是错的**：请求被拒（`busy`）、loop 崩了、网络断了，
 * 那行字就永远留在界面上，而用户已经看见它了。现在这行字必须**服务端真的落库了**
 * 才会出现 —— 显示的东西与存下来的东西不可能不一致。
 *
 * 代价是 user 行会晚几十毫秒出现（多一个 SSE 往返）。
 * 那个延迟换来的是「界面上有的东西一定存下来了」，我认为值。
 *
 * ## activeA 怎么定：认领，不是猜
 *
 * 每个 iframe 各自订阅 `loop.state.changed`。谁先看到 `running` 谁就把
 * `requestId` 记成 activeA —— 三个 iframe 会认领到**同一个** A（同一个事件）。
 * 之后所有 handler 第一件事就是 `if (p.requestId !== activeA) return`：
 * 这条不能松，**上一轮的迟到 token 不能污染新一轮**。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { sse, useCommand } from '@osteosome/core-client'
import type { Message, ThinkingEffort, ToolCall } from '@osteosome/shared'
import type { ChatRow } from './types'

/** 错误码 → 人话（前端唯一一份，别处不要重复这张表） */
const ERROR_LABEL: Record<string, string> = {
  unsupported_provider: 'provider 未注册或已下线',
  missing_credential: '缺少 API Key（请在设置里配置）',
  unauthorized: '认证失败（API Key 无效）',
  rate_limited: '请求过于频繁，请稍后再试',
  server_error: '上游服务错误',
  network: '网络异常，无法连接上游',
  invalid_request: '请求参数无效',
  busy: '上一轮还在跑，请稍候',
  tool_loop_limit: '工具轮超过上限，已中止',
}

export interface RunState {
  /** 历史 + 在途，合成时间线要渲染的行 */
  rowsView: ComputedRef<ChatRow[]>
  /** 正在跑这一轮吗（给 ③ 禁用按钮 / ② 显示尾光标） */
  sending: Ref<boolean>
  failed: Ref<string>
  /** 当前这一轮的 requestId（= `loop.run` 的 A） */
  activeA: Ref<string>
  bindEvents: () => void
  dispose: () => void
}

export interface RunStateOptions {
  /** 当前会话 id —— 每个 loop.* 事件都带它，用来确认「这一轮属于我正在看的会话」 */
  curId: () => string
  /** 当前会话的历史（已落库的消息），用于合成 rowsView */
  messages: () => Message[]
  /** 往 UI 推错误文案（时间线内联显示，输入框也会用到失败态） */
  onError?: (message: string) => void
}

export function useRunState(options: RunStateOptions): RunState {
  const sending = ref(false)
  const failed = ref('')
  const activeA = ref('')
  /** 在途行：key 用 `in-flight-<A>`，落库后由 message.appended 换成服务端 id */
  const inflight = ref<ChatRow[]>([])

  let unsubs: Array<() => void> = []

  function privateRow(): ChatRow | undefined {
    return inflight.value.find((r) => r.key === `in-flight-${activeA.value}`)
  }

  /** 占位行 id —— 由 A 推出来，所以每个 iframe 认领到的 A 相同，key 自然也相同 */
  function placeholderKey(requestId: string): string {
    return `in-flight-${requestId}`
  }

  function adopt(requestId: string, sessionId: string): void {
    // 只认「属于我正在看的会话」的那一轮：
    // 否则在会话 A 上跑的一轮，会在正看着会话 B 的时间线里冒出占位行
    if (sessionId !== options.curId()) return
    if (activeA.value === requestId) return
    // 认领前先清上一轮的残留（切会话时可能没等到 idle）
    inflight.value = []
    activeA.value = requestId
    sending.value = true
    failed.value = ''
    inflight.value = [{ key: placeholderKey(requestId), role: 'assistant', text: '', reasoning: '', pending: true }]
  }

  function bindEvents(): void {
    if (unsubs.length > 0) return

    unsubs.push(bindCurIdWatch())

    unsubs.push(
      // 开跑：认领 A 并造 assistant 占位行
      sse.subscribe('loop.state.changed', (payload) => {
        const p = payload as { requestId?: string; sessionId?: string; state?: string }
        if (!p?.requestId || !p.sessionId) return
        if (p.state === 'running') {
          adopt(p.requestId, p.sessionId)
        } else if (p.state === 'idle' && p.requestId === activeA.value) {
          sending.value = false
          // idle 时占位行应当已被 message.appended 换掉；还没被换掉说明这一轮
          // 没有产出任何内容（被取消 / 空回答），留着它就是个永远转圈的气泡
          inflight.value = inflight.value.filter((r) => r.key !== placeholderKey(p.requestId!))
          activeA.value = ''
        }
      }),

      // 流式 token：按块类型分流 —— reasoning 单独攒，不进正文
      sse.subscribe('loop.token.streamed', (payload) => {
        const p = payload as { requestId?: string; sessionId?: string; token?: string; blockType?: string }
        if (!p?.requestId || !p.sessionId) return
        if (p.requestId !== activeA.value || p.sessionId !== options.curId()) return
        const target = privateRow()
        if (!target || typeof p.token !== 'string') return
        if (p.blockType === 'reasoning') target.reasoning = (target.reasoning ?? '') + p.token
        else target.text += p.token
      }),

      // 工具块：执行中 → ✓ / ✗。与落库消息里的 toolCalls 按 id 合并，不覆盖
      sse.subscribe('loop.tool.executed', (payload) => {
        const p = payload as {
          requestId?: string
          sessionId?: string
          toolCallId?: string
          name?: string
          arguments?: string
          ok?: boolean
          summary?: string
        }
        if (!p?.requestId || !p.sessionId || !p.toolCallId) return
        if (p.requestId !== activeA.value || p.sessionId !== options.curId()) return
        const target = privateRow()
        if (!target) return
        target.toolCalls = target.toolCalls ?? []
        const existing = target.toolCalls.find((c) => c.id === p.toolCallId)
        if (existing) {
          existing.ok = p.ok
          existing.summary = p.summary
        } else {
          target.toolCalls.push({
            id: p.toolCallId,
            name: p.name ?? 'tool',
            arguments: p.arguments ?? '',
            ok: p.ok,
            summary: p.summary,
          })
        }
      }),

      // assistant 落库 → **删掉占位行**，内容改由历史带出
      sse.subscribe('message.appended', (payload) => {
        const p = payload as { sessionId?: string; message?: Message }
        if (!p?.sessionId || p.message?.role !== 'assistant') return
        if (p.sessionId !== options.curId()) return
        // 这里**不是**把占位行换成服务端 id，而是直接删掉 ——
        // 因为 `session.get` / `message.appended` 会把同一条消息放进 history 分支。
        // 换成 id 的话两条都在（一个在 history、一个在 inflight），界面上同一个回答出现两次。
        // 「删掉」与「history 补上」发生在同一个 tick，视觉上是原地换实现。
        inflight.value = inflight.value.filter((r) => r.key !== placeholderKey(activeA.value))
      }),

      // 失败：错误占位 + **只删空的** in-flight 行
      sse.subscribe('loop.run.failed', (payload) => {
        const p = payload as { requestId?: string; sessionId?: string; error?: { code?: string; message?: string } }
        if (!p?.requestId || p.requestId !== activeA.value) return
        const code = p.error?.code ?? ''
        const message = ERROR_LABEL[code] ?? p.error?.message ?? `请求失败（${code}）`
        failed.value = message
        options.onError?.(message)
        // 空的占位行是「幽灵」（用户会看到一个永远转圈、永远没内容的气泡）→ 删掉；
        // 已经有正文的**留着**：错误就内联在末尾，清掉等于把用户刚读到的东西抹掉。
        // 原来的代码是 `filter((r) => r.key !== key || r.text !== '')`，同一个判据。
        inflight.value = inflight.value.filter((r) => r.key !== placeholderKey(p.requestId!) || r.text !== '')
        sending.value = false
        activeA.value = ''
      }),

      // 取消：成功路径，不留半截 assistant
      sse.subscribe('loop.run.cancelled', (payload) => {
        const p = payload as { requestId?: string; sessionId?: string }
        if (!p?.requestId || p.requestId !== activeA.value) return
        inflight.value = inflight.value.filter((r) => r.key !== placeholderKey(p.requestId!))
        sending.value = false
        activeA.value = ''
      }),

      // loop 崩溃：清在途 + 输入恢复
      sse.subscribe('service.failed', (payload) => {
        const p = payload as { serviceId?: string }
        if (p?.serviceId !== 'loop') return
        inflight.value = inflight.value.filter((r) => !r.pending)
        sending.value = false
        activeA.value = ''
        failed.value = 'loop 服务异常，正在重连'
      }),
    )
  }

  /**
   * 切会话 → 清掉在途行与 activeA。
   *
   * **不这么做的话**上一轮的半截内容会留在新会话的时间线里，而它是另一个会话的。
   * 而在途行本来就不该跟着用户走 —— 它属于「那一轮」，那一轮属于某个会话。
   *
   * 这条监听放在 `bindEvents` 里（而不是让视图 watch curId），
   * 与 session.ts 里那条 watch 同一个理由：这是状态层的义务。
   */
  function bindCurIdWatch(): () => void {
    return watch(options.curId, () => {
      inflight.value = []
      activeA.value = ''
      sending.value = false
      failed.value = ''
    })
  }

  const rowsView = computed<ChatRow[]>(() => {
    const history = options.messages().map((m) => ({
      key: m.id,
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      text: m.content,
      ...(m.role === 'assistant' && m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.role === 'assistant' && m.finishReason ? { finishReason: m.finishReason } : {}),
      ...(m.role === 'assistant' && m.usage ? { usage: m.usage } : {}),
      // tool 消息本身不单独成气泡 —— 它们是工具结果，已并进下面的块
      ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
    }))
    return [...history, ...inflight.value]
  })

  return {
    rowsView,
    sending,
    failed,
    activeA,
    bindEvents,
    dispose: () => {
      for (const off of unsubs) off()
      unsubs = []
    },
  }
}

/** ③ 输入框那侧：发问（取消是独立的 `cancelRun(activeA)`，见其注释） */
export interface ComposerRun {
  submit: (text: string) => Promise<void>
}

export interface ComposerRunOptions {
  curId: () => string
  /** 没有当前会话时先建一个（返回新 id；建不出来返回空串） */
  ensureSession: () => Promise<string>
  /** 最近会话 —— 建会话的那一趟往返里可以用它兜底 */
  recent: () => { id: string } | undefined
  provider: () => string
  model: () => string
  thinking: () => ThinkingEffort
  onError: (message: string) => void
}

export function useComposerRun(options: ComposerRunOptions): ComposerRun {
  return {
    async submit(text: string): Promise<void> {
      const trimmed = text.trim()
      if (!trimmed) return

      let sessionId = options.curId()
      if (!sessionId) {
        sessionId = await options.ensureSession()
        if (!sessionId) sessionId = options.recent()?.id ?? ''
        if (!sessionId) {
          options.onError('没有可用会话')
          return
        }
      }

      const a = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const { send } = useCommand()
      const thinking = options.thinking()
      // 缺省参数不下发 → 后端回落 env / 模型默认档
      void send('loop.run', {
        requestId: a,
        sessionId,
        text: trimmed,
        ...(options.provider() ? { provider: options.provider() } : {}),
        ...(options.model() ? { model: options.model() } : {}),
        ...(thinking !== 'off' ? { thinking } : {}),
      })
      // **不返回、不等结果**：这一轮的全部后续（占位行 / token / 收尾）都由 SSE 驱动，
      // 这里等来的任何东西都会与事件重复。返回值保持 void 是刻意的。
    },

    }
}

/**
 * 取消当前这一轮。
 *
 * 需要 `activeA` 而不是让 store 自己记：cancel 必须带 `requestId`，
 * 而 `requestId` 只有**认领者**知道（每个 iframe 各自认领，见本文件头）。
 * 三个 iframe 里只有发送方有非空的 activeA —— 另外两个认领到的也是同一个 A，
 * 所以谁按「停止」都能取消同一轮，这是对的（用户在哪看都能停）。
 */
export function cancelRun(activeA: string): void {
  if (!activeA) return
  const { send } = useCommand()
  void send('loop.cancel', { requestId: activeA })
}