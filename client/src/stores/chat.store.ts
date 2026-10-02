import { defineStore } from 'pinia'
import type { Message, ThinkingEffort, ToolCall } from '@osteosome/shared'
import { useCommand } from '@/core-sdk/useCommand'
import { sse } from '@/core-sdk/sse'
import { useSessionStore } from '@/stores/session.store'

/** 时间线的一行（② 渲染的最小单位） */
export interface ChatRow {
  key: string
  role: 'user' | 'assistant'
  /** 正文。**不含思维链** —— S4 起 reasoning 单独走 `reasoning` 字段 */
  text: string
  /** S4：思维链（折叠块渲染这个，不进 `text`） */
  reasoning?: string
  pending?: boolean
  /** S4：这一轮为什么停（来自落库消息的 finishReason） */
  finishReason?: string
  /** S4：token 用量 */
  usage?: { promptTokens: number; completionTokens: number }
  /** P7：assistant 消息发起的工具调用（ok 未定义 = 执行中） */
  toolCalls?: (ToolCall & { ok?: boolean; summary?: string })[]
}

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

/**
 * 对话状态（S5）—— 从 `widget.llm-chat` 抽出来的**唯一真源**。
 *
 * ## 为什么要抽出来
 *
 * 原来 407 行里 290 行是逻辑，全塞在**一个**组件里，于是：
 * - 想单独做「只读的消息区」（比如嵌到别的面板）得把输入框一起带上
 * - 输入框的 `disabled` 与消息区共享同一份 `sending`，两个组件要通信就只能互相引用
 *
 * 抽成 store 后 ② timeline 与 ③ composer **零直接通信**，只共享这份状态
 * （对应架构文档 §1「②③ 之间不直接通信，共享 stores/chat.store.ts」）。
 *
 * ## 这个 store 刻意**不**持有 provider 列表与模型目录
 *
 * `useLlmProviders` / `useModelCatalog` 是**每次调用新建 ref** 的 composable（不是单例），
 * 且靠 `onMounted` 订阅 —— 只在组件 setup 上下文有效。所以：
 * - 在 store 的 getter 里调它们 → 拿到的是刚建的空实例，永远是空
 * - 在 store 里订阅 → 订阅挂在随后被丢弃的实例上，等于没绑
 *
 * 第一版就是踩了这个（provider 下拉恒空）。与其把这两个 composable 改成单例
 * （牵动 settings 等既有调用方），不如把依赖方向摆正：
 * **store 只管「这一轮对话」的 run 状态**；provider 下拉、模型目录这类展示派生数据
 * 由 ③ composer 在 setup 里持有，选中后写进 store。
 *
 * ## 事件如何不串轮
 *
 * 服务端事件都带同一个 `requestId`（= `loop.run` 的 A，前端只见 A）。所有 handler 第一件事就是
 * `if (p.requestId !== this.activeA) return`。这条是硬约束 —— 上一轮的迟到 token 不能污染新一轮。
 */
export const useChatStore = defineStore('chat', {
  state: () => ({
    /** 当前选中的 provider（空串 = 未选，发送时不下发该字段，由后端回落） */
    provider: '' as string,
    model: '' as string,
    thinking: 'off' as ThinkingEffort,
    /** 输入框草稿 */
    draft: '' as string,
    sending: false,
    /** 错误占位（内联在时间线末尾，不弹 Toast） */
    failed: '' as string,
    /** 在途 run 的 A（`loop.run` 的 requestId） */
    activeA: '' as string,
    /** 本地 in-flight 累积（虚拟 key，assistant 落库后由 message.appended 换成服务端 id） */
    rows: [] as ChatRow[],
    /** SSE 已绑定，避免 ②③ 各自重复订阅 */
    eventsBound: false,
  }),

  getters: {
    /** 历史（当前会话）+ 本地 in-flight，in-flight 永远挂末尾 */
    rowsView(state): ChatRow[] {
      const sessions = useSessionStore()
      const history = sessions.messages.map((m: Message) => ({
        key: m.id,
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        text: m.content,
        // S4：思维链 / 停因 / 用量都随消息落库了，这里直接带出来（折叠块与提示有数据了）
        ...(m.role === 'assistant' && m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.role === 'assistant' && m.finishReason ? { finishReason: m.finishReason } : {}),
        ...(m.role === 'assistant' && m.usage ? { usage: m.usage } : {}),
        // tool 消息本身不单独成气泡 —— 它们是工具结果，已并进下面的块
        ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
      }))
      return [...history, ...state.rows]
    },

    canSend(state): boolean {
      return Boolean(state.draft.trim()) && !state.sending
    },
  },

  actions: {
    /** 绑定 SSE；②③ 各自 onMounted 调（内部幂等，共享同一批订阅） */
    bindEvents(): void {
      if (this.eventsBound) return
      this.eventsBound = true

      // 历史载入：写进 session store（那里才是 messages 的主人）
      sse.subscribe('session.get.result', (payload) => {
        const p = payload as { session?: { messages?: unknown[] } | null }
        const sessions = useSessionStore()
        if (!p?.session) {
          // 会话为空/已删 → 回退最近会话
          const fallback = sessions.recent
          if (fallback && fallback.id !== sessions.curId) sessions.select(fallback.id)
          return
        }
        sessions.messages = (p.session.messages ?? []) as Message[]
      })

      // 流式 token：**按块类型分流**（S4）—— reasoning 单独攒，不进正文
      sse.subscribe('loop.token.streamed', (payload) => {
        if (!payload || typeof payload !== 'object' || !this.sending) return
        const p = payload as { requestId?: string; token?: string; blockType?: string }
        if (p.requestId !== this.activeA) return
        const target = this.privateRow()
        if (!target || typeof p.token !== 'string') return
        if (p.blockType === 'reasoning') target.reasoning = (target.reasoning ?? '') + p.token
        else target.text += p.token
      })

      // 工具块从「执行中」变成功/失败；与落库消息里的 toolCalls 按 id 合并，不覆盖
      sse.subscribe('loop.tool.executed', (payload) => {
        if (!payload || typeof payload !== 'object') return
        const p = payload as {
          requestId?: string
          toolCallId?: string
          name?: string
          arguments?: string
          ok?: boolean
          summary?: string
        }
        if (p.requestId !== this.activeA || !p.toolCallId) return
        const target = this.privateRow()
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
      })

      // assistant 落库 → in-flight 换服务端 id（视图 id 切换，不重放 content）
      sse.subscribe('message.appended', (payload) => {
        const p = payload as { sessionId?: string; message?: { id?: string; role?: string } }
        const sessions = useSessionStore()
        if (!p?.sessionId || p.sessionId !== sessions.curId || p.message?.role !== 'assistant') return
        const target = this.privateRow()
        if (target) {
          target.key = p.message.id ?? target.key
          target.pending = false
        }
      })

      // loop 收尾 → spinner 收起 / 输入恢复
      sse.subscribe('loop.state.changed', (payload) => {
        const p = payload as { requestId?: string; state?: string }
        if (!p?.requestId || p.requestId !== this.activeA) return
        if (p.state === 'idle') this.sending = false
      })

      // 失败：错误占位 + 不留幽灵 assistant（空的 in-flight 行）
      sse.subscribe('loop.run.failed', (payload) => {
        if (!payload || typeof payload !== 'object') return
        const p = payload as { requestId?: string; error?: { code?: string; message?: string } }
        if (p.requestId !== this.activeA) return
        const code = p.error?.code ?? ''
        this.rows = this.rows.filter((r) => r.key !== `in-flight-${this.activeA}` || r.text !== '')
        this.failed = ERROR_LABEL[code] ?? p.error?.message ?? `请求失败（${code}）`
        this.sending = false
        this.activeA = ''
      })

      // 取消：成功路径，不留半截 assistant
      sse.subscribe('loop.run.cancelled', (payload) => {
        const p = payload as { requestId?: string }
        if (p?.requestId !== this.activeA) return
        this.rows = this.rows.filter((r) => r.key !== `in-flight-${this.activeA}`)
        this.sending = false
        this.activeA = ''
      })

      // loop 崩溃：清 in-flight + 输入恢复（跨组件生效，不用组件间通信）
      sse.subscribe('service.failed', (payload) => {
        const p = payload as { serviceId?: string }
        if (p?.serviceId !== 'loop') return
        this.rows = this.rows.filter((r) => !r.pending)
        this.sending = false
        this.activeA = ''
        this.failed = 'loop 服务异常，正在重连'
      })
    },

    /** 换 provider：模型落到该家的**声明默认模型**（由调用方从 provider 描述取好传进来） */
    setProvider(name: string, declaredDefaultModel: string): void {
      this.provider = name
      this.model = declaredDefaultModel
    },

    setModel(model: string): void {
      this.model = model
    },

    setThinking(value: string): void {
      if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') this.thinking = value
    },

    /** 切会话 / 首次进入：载入历史 + 重置本地 in-flight */
    async onSessionChanged(sessionId: string): Promise<void> {
      this.reset()
      if (sessionId) await this.loadHistory(sessionId)
    },

    async loadHistory(sessionId: string): Promise<void> {
      const { send } = useCommand()
      await send('session.get', { requestId: `get-${Date.now()}`, sessionId })
    },

    /** 清掉本地 in-flight 与错误（不碰服务端历史） */
    reset(): void {
      this.rows = []
      this.failed = ''
      this.sending = false
      this.activeA = ''
    },

    /** 找本轮的 in-flight assistant 行 */
    privateRow(): ChatRow | undefined {
      return this.rows.find((r) => r.key === `in-flight-${this.activeA}`)
    },

    /** 发问：建会话（如需）→ loop.run → 建本地 in-flight 行 */
    async submit(): Promise<void> {
      const text = this.draft.trim()
      if (!text || this.sending) return
      this.draft = ''
      this.failed = ''

      const sessions = useSessionStore()
      // 会话不存在 → 先建（会话创建是前端职责）
      if (!sessions.curId) {
        const requestId = await sessions.create()
        if (!requestId) {
          this.failed = '创建会话失败，请重试'
          return
        }
      }
      const sessionId = sessions.curId || sessions.recent?.id || ''
      if (!sessionId) {
        this.failed = '没有可用会话'
        return
      }
      sessions.select(sessionId)

      const a = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
      this.activeA = a
      this.sending = true
      // 本地 in-flight：user 立即可见 + assistant 累积位（虚拟 id，落库后换成服务端 id）
      this.rows = [
        { key: `local-user-${a}`, role: 'user', text },
        { key: `in-flight-${a}`, role: 'assistant', text: '', reasoning: '', pending: true },
      ]
      // 缺省参数不下发 → 后端回落 env / 模型默认档
      const { send } = useCommand()
      void send('loop.run', {
        requestId: a,
        sessionId,
        text,
        ...(this.provider ? { provider: this.provider } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.thinking !== 'off' ? { thinking: this.thinking } : {}),
      })
    },

    cancel(): void {
      if (this.activeA) {
        const { send } = useCommand()
        void send('loop.cancel', { requestId: this.activeA })
      }
    },
  },
})
