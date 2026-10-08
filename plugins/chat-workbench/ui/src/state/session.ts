/**
 * 会话状态 —— 每个 iframe **各自**从 Core 重建（P6）。
 *
 * ## 与 client 侧 `stores/session.store.ts` 的关系：同一个东西，pinia 没了
 *
 * 原来是 pinia 单例，三个视图共享同一份。现在三个 iframe 各有一份 —— 但
 * **它们的内容必然一致**，因为都来自同一批服务端事件。这不是「凑巧一样」，
 * 是有依据的：每个事件都自带 `sessionId`，过滤条件（curId）又只有一个来源
 * （见 `session-sync.ts`）。
 *
 * ## 为什么不用 pinia
 *
 * pinia 的价值是「跨组件共享单例」，而这里每个 iframe 里**只有一个视图**用它 ——
 * 组件之间本来就不共享引用（跨 iframe 也共享不了），那 pinia 剩的只有
 * `defineStore` 的样板与一个必须 `createPinia()` 的前提。
 *
 * 插件 UI 不挂 pinia 与 P5 一致：models/ui 那个界面一个 store 都没用到，
 * 于是没挂。chat-workbench 确实用到状态，但那份状态是**局部**的，不需要 store。
 *
 * ## 每个事件都按 sessionId 过滤，而不是「全收」
 *
 * `message.appended` 是**广播**（任何会话的消息追加都会到每个订阅者）。
 * 不按 curId 过滤的话，切到会话 B 之后 A 的消息会冒进时间线 ——
 * 而这是最难查的那类 bug：数据看起来是对的，只是**多了不该有的**。
 */
import { ref, watch, type Ref } from 'vue'
import { sse, useCommand } from '@osteosome/core-client'
import type { Message, SessionMeta } from '@osteosome/shared'
import { currentSessionId, setCurrentSessionId } from './session-sync'

export interface SessionState {
  /** 全量会话索引（按 updatedAt 倒序展示） */
  list: Ref<SessionMeta[]>
  /** 当前会话的消息缓存 —— 只装 curId 那一个会话的（首屏一页 + 已加载的更早页） */
  messages: Ref<Message[]>
  /** 是否还有更早的消息可加载（P3-1 M3 分页） */
  hasMore: Ref<boolean>
  /** 正在加载更早一页 */
  loadingMore: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string>
  hydrated: Ref<boolean>
  /** 最近会话（updatedAt 最大） */
  recent: () => SessionMeta | undefined
  /** curId 对应的元信息 */
  current: () => SessionMeta | undefined
  bootstrap: () => Promise<void>
  /** 切换当前会话（会写进跨 iframe 共享层） */
  select: (sessionId: string) => void
  /**
   * 新建会话，**返回真的 sessionId**（拿不到返回空串）。
   *
   * 等的是 `session.create.result` 而不是 `session.create` 的 HTTP 回执 ——
   * 后者只表示「命令收到了」，里面没有 id。而调用方（③ 的 `ensureSession`）
   * 拿这个值去发 `loop.run`，给错的话新会话的第一句就跑到一个不存在的会话上。
   */
  create: (title?: string) => Promise<string>
  rename: (sessionId: string, title: string) => Promise<boolean>
  remove: (sessionId: string) => Promise<boolean>
  /** 置顶 / 取消置顶（P2-1）。**不改 updatedAt** */
  pin: (sessionId: string, pinned: boolean) => Promise<boolean>
  /** 归档 / 取消归档（P2-2） */
  archive: (sessionId: string, archived: boolean) => Promise<boolean>
  /** 导出会话为 Markdown（P2-5）；失败返回 null */
  exportSession: (sessionId: string) => Promise<{ filename: string; content: string } | null>
  /**
   * 载入某个会话的历史（`session.get`）。
   *
   * **每个 iframe 都要自己调** —— 历史不共享。共享层只传 curId，
   * 而 curId 变化时三个 iframe 各自 watch 到、各自载入一遍。
   */
  loadHistory: (sessionId: string) => Promise<void>
  /** 加载更早一页（P3-1 M3）：`session.get` 带 `before=nextCursor`，结果 prepend */
  loadMore: () => Promise<void>
  /** 仅测试用：解绑本函数绑的事件 */
  dispose: () => void
}

/** 每次 `session.get` 取多少条（P3-1 M3）；服务端上限 500。 */
const PAGE_SIZE = 50

function toMeta(payload: unknown): SessionMeta | undefined {
  const p = payload as Partial<SessionMeta> & { sessionId?: string }
  if (!p || typeof p !== 'object') return undefined
  const id = p.id ?? p.sessionId
  if (typeof id !== 'string' || !id) return undefined
  return {
    id,
    title: typeof p.title === 'string' ? p.title : '新会话',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
    ...(typeof p.workspace === 'string' ? { workspace: p.workspace } : {}),
    ...(Array.isArray(p.workspaces) ? { workspaces: p.workspaces } : {}),
  }
}

export function useSessionState(): SessionState {
  const list = ref<SessionMeta[]>([])
  const messages = ref<Message[]>([])
  const hasMore = ref(false)
  const loadingMore = ref(false)
  /** 上一页返回的更早游标；`loadMore` 用它取下一页。内部态，不对外暴露 */
  const nextCursor = ref('')
  const loading = ref(false)
  const error = ref('')
  const hydrated = ref(false)
  const curId = currentSessionId()

  /** 本函数绑的退订函数；bindEvents 幂等，重复调用不叠加 */
  let unsubs: Array<() => void> = []

  /** 在途的 `session.get`：requestId → { mode, sessionId }。用配对而非「全收」，防别的 iframe 的结果串进来 */
  const pendingGets = new Map<string, { mode: 'replace' | 'prepend'; sessionId: string }>()

  /**
   * 在途的 `create()`：`requestId → 结算`。
   *
   * 常驻订阅 `session.create.result` 收到回执后按 requestId 找回来（见 bindEvents 里那段注释）。
   * 为什么不是「每次创建临时订阅一次」：那会换流，缝里丢事件。
   */
  const pendingCreates = new Map<string, (sessionId: string) => void>()

  /** 在途的 `exportSession()`：`requestId → 结算`（与 create 同一套常驻订阅配对手法） */
  const pendingExports = new Map<string, (result: { filename: string; content: string } | null) => void>()

  function sortList(items: SessionMeta[]): SessionMeta[] {
    return [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async function loadList(): Promise<void> {
    loading.value = true
    const { send } = useCommand()
    const ok = await send('session.list', { requestId: `list-${Date.now()}` })
    if (!ok) error.value = 'session.list 命令发送失败'
    loading.value = false
  }

  function bindEvents(): void {
    if (unsubs.length > 0) return

    /**
     * curId 变了 → 载入新会话的历史。
     *
     * 放在这里而不是让视图 `watch`，是因为「curId 变了要载入历史」是**状态层的义务**：
     * 三个视图里有历史需求的只有 ②，而它现在不需要知道这件事 ——
     * 视图里少一处 watch，就少一处「忘了同步」的写法。
     *
     * `immediate: true`：curId 可能在本 iframe 挂载**之前**就已经被 ① 选好了
     * （共享层是持久化在 sessionStorage 里的，切标签页回来时必然如此）。
     * 不 immediate 的话那一次载入永远不会发生，而症状是
     * 「会话列表高亮着某一行，时间线却是空的」。
     */
    unsubs.push(
      watch(curId, (sessionId) => void loadHistory(sessionId), { immediate: true }),
    )

    unsubs.push(
      sse.subscribe('session.list.result', (payload) => {
        const p = payload as { sessions?: SessionMeta[] }
        if (Array.isArray(p?.sessions)) list.value = sortList(p.sessions)
      }),
      sse.subscribe('session.created', (payload) => {
        const meta = toMeta(payload)
        if (!meta) return
        list.value = sortList([...list.value.filter((m) => m.id !== meta.id), meta])
      }),
      sse.subscribe('session.updated', (payload) => {
        const p = payload as {
          sessionId?: string
          title?: string
          updatedAt?: string
          pinned?: boolean
          archived?: boolean
          lastMessage?: string
          workspace?: string
          workspaces?: string[]
        }
        if (!p?.sessionId) return
        list.value = sortList(
          list.value.map((m) =>
            m.id === p.sessionId
              ? {
                  ...m,
                  ...(p.title ? { title: p.title } : {}),
                  ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
                  // pinned/archived 用「显式出现才改」：undefined = 本条没提，不动
                  ...(p.pinned !== undefined ? { pinned: p.pinned || undefined } : {}),
                  ...(p.archived !== undefined ? { archived: p.archived || undefined } : {}),
                  ...(p.lastMessage ? { lastMessage: p.lastMessage } : {}),
                  ...(p.workspace !== undefined ? { workspace: p.workspace || undefined } : {}),
                  ...(p.workspaces !== undefined ? { workspaces: p.workspaces } : {}),
                }
              : m,
          ),
        )
      }),
      sse.subscribe('session.deleted', (payload) => {
        const p = payload as { sessionId?: string }
        if (!p?.sessionId) return
        list.value = list.value.filter((m) => m.id !== p.sessionId)
      }),
      // 消息是广播，必须按 curId 过滤 —— 见文件头
      sse.subscribe('message.appended', (payload) => {
        const p = payload as { sessionId?: string; message?: Message }
        if (!p?.sessionId || !p.message || p.sessionId !== curId.value) return
        if (messages.value.some((m) => m.id === p.message!.id)) return
        messages.value = [...messages.value, p.message]
      }),
      // 切会话 → 清缓存并载入新会话的历史。
      // **每个 iframe 都要自己载入**：curId 从共享层来，但历史不共享。
      //
      // P3-1 M3：结果恒带 `page`。用 requestId 配对区分「首屏替换」与「加载更早 prepend」；
      // 没有配对时（例如测试注入）退化为按 `meta.id === curId` 判断的替换。
      sse.subscribe('session.get.result', (payload) => {
        const p = payload as {
          requestId?: string
          session?: { meta?: { id?: string }; messages?: unknown[] } | null
          page?: { hasMore?: boolean; nextCursor?: string | null; total?: number }
        }
        const req = p?.requestId ? pendingGets.get(p.requestId) : undefined
        if (req?.mode === 'prepend') loadingMore.value = false

        const targetId = req?.sessionId ?? p?.session?.meta?.id
        // 别的会话的结果不串进来（广播 + 三个 iframe）
        if (targetId && targetId !== curId.value) return
        if (p?.requestId) pendingGets.delete(p.requestId)

        if (!p?.session) {
          // 会话为空/已删
          messages.value = []
          hasMore.value = false
          return
        }
        const incoming = (p.session.messages ?? []) as Message[]
        if (req?.mode === 'prepend') {
          const seen = new Set(messages.value.map((m) => m.id))
          messages.value = [...incoming.filter((m) => !seen.has(m.id)), ...messages.value]
        } else {
          messages.value = incoming
        }
        hasMore.value = p.page?.hasMore === true
        nextCursor.value = p.page?.nextCursor ?? ''
      }),
      /**
       * `session.create.result` **必须常驻**，不能在 `create()` 里临时订阅。
       *
       * ## 为什么（这个坑踩过两次，形态不同、根因同一）
       *
       * `sse.subscribe()` 遇到**新 topic** 会 `reconnect()` —— 关掉正在用的 EventSource、
       * 另开一条新的，而新的那条**此刻还没 open**（对端尚未登记）。
       * 于是紧接着发出的命令，回执与伴随事件就落进「旧流已关、新流未开」的缝里：
       * - 这里的表现：`session.created` 丢了 → **会话列表不刷新**；
       *   连 `session.create.result` 也丢了 → `create()` 干等 10 秒兜底才返回空串，
       *   于是「新建后自动切到新会话」也没做。
       * - `useLlmProviders` 那次是同一个病（清单一直空），修法也是「对齐等到 connected」。
       *
       * ## 为什么不能改成「两条流重叠、新的 open 之后再关旧的」
       *
       * 重叠期同一事件会被投递两次，而 `loop.token.streamed` 是**直接追加、无去重**
       * （payload 里也没有序号可去重）—— 那是刚修的「事件只到一次」那套设计的前提。
       * 所以这条路上**只能消灭触发点**，不能靠双流兜住。
       *
       * 规矩：**不要为一次命令临时订阅 topic**。要等回执，就常驻订阅 + 本地按 requestId 配对
       * （就像 `useEndpointProbe` 按 provider 归档那样）。
       */
      sse.subscribe('session.create.result', (payload) => {
        const p = payload as { requestId?: string; sessionId?: string }
        const requestId = p?.requestId
        if (!requestId) return
        const resolve = pendingCreates.get(requestId)
        if (!resolve) return // 不是本 iframe 发的那次创建（别的 iframe 也收这条广播）
        pendingCreates.delete(requestId)
        resolve(p.sessionId ?? '')
      }),
      // 导出结果同样按 requestId 常驻配对（不为一次命令临时订阅 topic，见上面的坑）
      sse.subscribe('session.export.result', (payload) => {
        const p = payload as { requestId?: string; filename?: string; content?: string; error?: unknown }
        const requestId = p?.requestId
        if (!requestId) return
        const resolve = pendingExports.get(requestId)
        if (!resolve) return
        pendingExports.delete(requestId)
        resolve(p.error || typeof p.content !== 'string' ? null : { filename: p.filename ?? 'session.md', content: p.content })
      }),
    )
  }

  async function bootstrap(): Promise<void> {
    // **先订阅再发命令**。反过来的话 `session.list.result` 可能在 `bindEvents`
    // 之前到达 —— 那一份回执就永远丢了，症状是列表一直空着而命令明明成功了。
    // SSE 与 HTTP 是两条连接，谁先到没有任何保证。
    bindEvents()
    await loadList()
    hydrated.value = true
  }

  async function loadHistory(sessionId: string): Promise<void> {
    // 切会话先清分页态（否则新会话会沿用旧会话的 hasMore / 加载中）
    hasMore.value = false
    loadingMore.value = false
    nextCursor.value = ''
    if (!sessionId) {
      messages.value = []
      return
    }
    messages.value = []
    const { send } = useCommand()
    const requestId = `get-${Date.now()}-${Math.random().toString(16).slice(2)}`
    pendingGets.set(requestId, { mode: 'replace', sessionId })
    await send('session.get', { requestId, sessionId, limit: PAGE_SIZE })
  }

  /** 加载更早一页（P3-1 M3）：带 `before=nextCursor`；结果由 handler prepend。 */
  async function loadMore(): Promise<void> {
    const sessionId = curId.value
    if (!sessionId || !hasMore.value || loadingMore.value) return
    loadingMore.value = true
    const { send } = useCommand()
    const requestId = `more-${Date.now()}-${Math.random().toString(16).slice(2)}`
    pendingGets.set(requestId, { mode: 'prepend', sessionId })
    await send('session.get', { requestId, sessionId, limit: PAGE_SIZE, before: nextCursor.value })
  }

  return {
    list,
    messages,
    hasMore,
    loadingMore,
    loading,
    error,
    hydrated,
    recent: () => (list.value.length === 0 ? undefined : [...list.value].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]),
    current: () => list.value.find((m) => m.id === curId.value),
    bootstrap,
    select: (sessionId: string) => {
      error.value = ''
      // 写共享层 → 另外两个 iframe 的 curId 也变，各自 watch 到再载入历史
      setCurrentSessionId(sessionId)
    },
    async create(title?: string): Promise<string> {
      // 常驻订阅在 bindEvents 里；这里兜一道，别让「没 bootstrap 就 create」变成干等 10 秒
      bindEvents()
      const { send } = useCommand()
      const requestId = `create-${Date.now()}-${Math.random().toString(16).slice(2)}`

      let resolveResult: (value: string) => void = () => {}
      const result = new Promise<string>((resolve) => {
        resolveResult = resolve
      })

      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      /** 全部出口都走这里：停表、清登记、回值。重复调用第一次之外的一律忽略 */
      const finish = (value: string): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        pendingCreates.delete(requestId)
        resolveResult(value)
      }

      // **登记在发命令之前**：常驻订阅可能已经把回执送来了（bindEvents 的兜底保证了订阅在）
      pendingCreates.set(requestId, finish)
      // Core挂了 / 回执丢了：不能把调用方永远吊着 ——
      // ③ 会一直停在「发送中」，而用户看不出发生了什么
      timer = setTimeout(() => finish(''), 10_000)

      const ok = await send('session.create', { requestId, ...(title ? { title } : {}) })
      if (!ok) {
        finish('')
        return ''
      }

      const sessionId = await result
      if (sessionId) {
        // 顺手把共享层也切过去：新建之后用户显然在看新建的那一个，
        // 不必等 `session.created` 的广播再由 ① 转一道。
        // **本地先赋值再写盘** —— storage 事件不在写入方触发，见 session-sync.ts。
        setCurrentSessionId(sessionId)
      }
      return sessionId
    },
    async rename(sessionId: string, title: string): Promise<boolean> {
      const { send } = useCommand()
      return send('session.rename', { requestId: `ren-${Date.now()}`, sessionId, title })
    },
    async remove(sessionId: string): Promise<boolean> {
      const { send } = useCommand()
      return send('session.delete', { requestId: `del-${Date.now()}`, sessionId })
    },
    async pin(sessionId: string, pinned: boolean): Promise<boolean> {
      const { send } = useCommand()
      return send('session.pin', { requestId: `pin-${Date.now()}`, sessionId, pinned })
    },
    async archive(sessionId: string, archived: boolean): Promise<boolean> {
      const { send } = useCommand()
      return send('session.archive', { requestId: `arc-${Date.now()}`, sessionId, archived })
    },
    async exportSession(sessionId: string): Promise<{ filename: string; content: string } | null> {
      bindEvents()
      const { send } = useCommand()
      const requestId = `exp-${Date.now()}-${Math.random().toString(16).slice(2)}`
      let settle: (result: { filename: string; content: string } | null) => void = () => {}
      const result = new Promise<{ filename: string; content: string } | null>((resolve) => {
        settle = resolve
      })
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: { filename: string; content: string } | null): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        pendingExports.delete(requestId)
        settle(value)
      }
      pendingExports.set(requestId, finish)
      timer = setTimeout(() => finish(null), 10_000)
      const ok = await send('session.export', { requestId, sessionId })
      if (!ok) {
        finish(null)
        return null
      }
      return result
    },
    loadHistory,
    loadMore,
    dispose: () => {
      for (const off of unsubs) off()
      unsubs = []
      pendingGets.clear()
    },
  }
}