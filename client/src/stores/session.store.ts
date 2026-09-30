import { defineStore } from 'pinia'
import { useCommand } from '@/core-sdk/useCommand'
import { sse } from '@/core-sdk/sse'
import type { Message, SessionMeta } from '@osteosome/shared'

/**
 * 会话状态（P3 WS-4）—— list 全量索引 + curId 当前会话（本地态）+ 消息缓存。
 *
 * 跨窗同步（P3 §3.4）：
 * - `list` 经 SSE 事件（session.created/updated/deleted）实时同步——**会话列表跨窗一致**；
 * - `curId` 是**本地态**（不跨窗同步、不落 preferences）——各窗独立选当前会话。
 * - `messages` 为当前会话的消息缓存（`session.get.result` 载入 + `message.appended` 增量）。
 */
export const useSessionStore = defineStore('sessions', {
  state: () => ({
    /** 全量会话索引（按 updatedAt 倒序展示） */
    list: [] as SessionMeta[],
    /** 当前会话 id（本地态；不跨窗、不落盘） */
    curId: '' as string,
    /** 当前会话消息缓存 */
    messages: [] as Message[],
    loading: false,
    error: '' as string,
    hydrated: false,
    /** SSE 事件已绑定（避免重复绑） */
    eventsBound: false,
  }),

  getters: {
    /** 当前会话元信息 */
    current(state): SessionMeta | undefined {
      return state.list.find((m) => m.id === state.curId)
    },
    /** 「最近会话」= updatedAt 最大的一条（P3 §0.2 定义） */
    recent(state): SessionMeta | undefined {
      if (state.list.length === 0) return undefined
      return [...state.list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
    },
  },

  actions: {
    /** bootstrap：拉会话列表 + 绑定 SSE（跨窗实时） */
    async bootstrap(): Promise<void> {
      await this.loadList()
      this.bindEvents()
      this.hydrated = true
    },

    async loadList(): Promise<void> {
      this.loading = true
      const { send } = useCommand()
      const ok = await send('session.list', { requestId: `list-${Date.now()}` })
      if (!ok) this.error = 'session.list 命令发送失败'
      this.loading = false
    },

    /** 绑定 SSE 事件（会话列表跨窗实时；curId 不参与） */
    bindEvents(): void {
      if (this.eventsBound) return
      this.eventsBound = true

      sse.subscribe('session.list.result', (payload) => {
        const p = payload as { requestId?: string; sessions?: SessionMeta[] }
        if (Array.isArray(p?.sessions)) {
          this.list = p.sessions
          this.sortList()
        }
      })
      sse.subscribe('session.created', (payload) => {
        const meta = this.toMeta(payload)
        if (!meta) return
        this.list = [...this.list.filter((m) => m.id !== meta.id), meta]
        this.sortList()
      })
      sse.subscribe('session.updated', (payload) => {
        const p = payload as { sessionId?: string; title?: string; updatedAt?: string }
        if (!p?.sessionId) return
        this.list = this.list.map((m) =>
          m.id === p.sessionId
            ? { ...m, ...(p.title ? { title: p.title } : {}), ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}) }
            : m,
        )
        this.sortList()
      })
      sse.subscribe('session.deleted', (payload) => {
        const p = payload as { sessionId?: string }
        if (!p?.sessionId) return
        this.list = this.list.filter((m) => m.id !== p.sessionId)
        // 删除当前会话 → curId 失效 + 消息缓存清空（不回退，由调用方决定）
        if (this.curId === p.sessionId) {
          this.curId = ''
          this.messages = []
        }
      })
      sse.subscribe('message.appended', (payload) => {
        const p = payload as { sessionId?: string; message?: Message }
        if (!p?.sessionId || !p?.message) return
        if (p.sessionId !== this.curId) return // 非当前会话不缓存
        // append-only：服务端已落库，前端缓存追加（id 去重防重放）
        if (this.messages.some((m) => m.id === p.message!.id)) return
        this.messages = [...this.messages, p.message]
      })
    },

    toMeta(payload: unknown): SessionMeta | undefined {
      const p = payload as Partial<SessionMeta> & { sessionId?: string }
      if (!p || typeof p !== 'object') return undefined
      const id = p.id ?? p.sessionId
      if (typeof id !== 'string' || !id) return undefined
      return {
        id,
        title: typeof p.title === 'string' ? p.title : '新会话',
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
      }
    },

    sortList(): void {
      this.list = [...this.list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    },

    /** 切换当前会话（本地态；不跨窗） */
    select(sessionId: string): void {
      this.curId = sessionId
      this.messages = []
      this.error = ''
    },

    /** 新建会话（title 默认「新会话」）；返回 requestId（结果经 session.create.result 异步回） */
    async create(title?: string): Promise<string> {
      const { send } = useCommand()
      const requestId = `create-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const ok = await send('session.create', { requestId, ...(title ? { title } : {}) })
      return ok ? requestId : ''
    },

    async rename(sessionId: string, title: string): Promise<boolean> {
      const { send } = useCommand()
      return send('session.rename', { requestId: `ren-${Date.now()}`, sessionId, title })
    },

    async remove(sessionId: string): Promise<boolean> {
      const { send } = useCommand()
      return send('session.delete', { requestId: `del-${Date.now()}`, sessionId })
    },
  },
})
