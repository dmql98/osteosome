/**
 * 对话流状态 —— 对应 osteosome `plugins/chat-workbench/ui/src/state/`。
 *
 * ## 最重要的一条纪律：状态是**派生**出来的
 *
 * 不是「A 改了本地状态、通知 B 同步」。而是：
 * 事件流（这里是 mock 的 SSE）→ 订阅 → 拼出视图。
 *
 * 这条纪律一旦破坏（开始「本地改了、发消息通知对方」），就会掉回
 * 「消息层 + 消息形状 + 消息丢失」那一整套排障地狱。
 *
 * ## 为什么不用 pinia
 *
 * osteosome 的插件 UI **不挂 pinia**。理由写在 `state/index.ts` 文件头：
 * 搬进 iframe 之后同一 JS 上下文里只剩一个视图，组件之间本来就不共享引用，
 * 于是 pinia 只剩下 `defineStore` 的样板和「必须先 createPinia()」的前提。
 *
 * 本 Demo 是单页应用（不拆 iframe），但**仍然按无 store 的写法**：
 * 用 Vue 的 `reactive` 局部状态，而不是全局单例。
 * 这样迁回 osteosome 时不需要改状态组织方式。
 *
 * ## 与真实 SSE 的差异
 *
 * 真实实现订阅 `loop.token.streamed` / `loop.tool.executed` / `message.appended`。
 * 这里用一个 mock 事件源模拟同样的 topic 与载荷形状 ——
 * **换成真 SSE 时只需替换 `subscribe` 的实现，其余代码不动**。
 */
;(function (global) {
  'use strict'

  const Vue = global.Vue

  /**
   * Mock 事件源 —— 顶替 `sse.subscribe()`。
   *
   * 真实 SSE 的形状：`subscribe(topic, handler) => disposer`，
   * 事件通过 `loop.token.streamed` 这样的 topic 到达，payload 是普通对象。
   */
  function createMockBus() {
    const handlers = new Map()
    return {
      subscribe(topic, fn) {
        if (!handlers.has(topic)) handlers.set(topic, new Set())
        handlers.get(topic).add(fn)
        return () => handlers.get(topic).delete(fn)
      },
      emit(topic, payload) {
        const set = handlers.get(topic)
        if (!set) return
        for (const fn of Array.from(set)) fn(payload)
      },
    }
  }

  const bus = createMockBus()

  /** 一行消息 —— 对应 osteosome 的 `ChatRow` */
  /**
   * @typedef {Object} ChatRow
   * @property {string} key
   * @property {'user'|'assistant'} role
   * @property {string} text
   * @property {string} [reasoning]
   * @property {number} [reasoningMs]
   * @property {boolean} [pending]
   * @property {boolean} [thinkingOpen]
   * @property {boolean} [toolsOpen]
   * @property {Array} [toolCalls]
   * @property {number} [ms]
   * @property {{prompt:number,completion:number}} [usage]
   * @property {number} [speed]
   * @property {number} [cacheHit]
   * @property {boolean} [stopped]
   */

  /**
   * 创建一个对话流的独立状态实例。
   *
   * 每个视图（timeline / composer）各自持有自己需要的那份 ——
   * 与 osteosome「每个 iframe 里只有一个视图用自己那份」一致。
   */
  function createChatState() {
    const state = Vue.reactive({
      /** @type {ChatRow[]} */
      rows: [],
      /** @type {string} */
      activeTurnKey: '',
      /** @type {boolean} */
      sending: false,
      /** @type {string} */
      failed: '',
      /** @type {Array<{key:string,label:string}>} */
      turns: [],
    })

    const disposers = []

    /** 找到或创建某轮的行 */
    function ensureRow(role, key) {
      let row = state.rows.find((r) => r.key === key)
      if (!row) {
        row = { key, role, text: '', pending: role === 'assistant' }
        state.rows.push(row)
      }
      return row
    }

    /** 记录一个 Turn 的导航条目 */
    function pushTurn(key, label) {
      if (state.turns.some((t) => t.key === key)) return
      state.turns.push({ key, label })
    }

    /**
     * 绑定事件流 —— 与 osteosome `state/run.ts` 的 `bindEvents()` 同构。
     *
     * 注意每条事件的 `requestId` 过滤：**这是防止串轮的关键**。
     * 没有它，两轮并发的 token 会互相写串。
     */
    function bindEvents() {
      disposers.push(
        // 用户消息落库 → 出现 user 行
        bus.subscribe('message.appended', (p) => {
          if (p.role !== 'user') return
          const row = ensureRow('user', p.id)
          row.text = p.text
          pushTurn(p.turnKey || p.id, p.text.slice(0, 12))
        }),

        // loop 开始运行 → 出现 assistant 占位行
        bus.subscribe('loop.state.changed', (p) => {
          if (p.state === 'running') {
            const row = ensureRow('assistant', p.requestId)
            row.pending = true
            state.sending = true
            pushTurn(p.turnKey || p.requestId, p.label || '新的一轮')
          } else if (p.state === 'idle') {
            state.sending = false
            const row = state.rows.find((r) => r.key === p.requestId)
            if (row && row.pending && !row.text) {
              // 空的在途行不该留下 —— 落库事件会补上真正的一行
              state.rows = state.rows.filter((r) => r.key !== p.requestId)
            }
          }
        }),

        // token 到达 → 累加正文（reasoning 分流到思考块）
        bus.subscribe('loop.token.streamed', (p) => {
          const row = state.rows.find((r) => r.key === p.requestId)
          if (!row) return
          if (p.blockType === 'reasoning') {
            row.reasoning = (row.reasoning || '') + p.token
            row.reasoningMs = row.reasoningMs || p.elapsedMs
          } else {
            row.text += p.token
          }
        }),

        // 工具调用完成 → 并进 toolCalls
        bus.subscribe('loop.tool.executed', (p) => {
          const row = state.rows.find((r) => r.key === p.requestId)
          if (!row) return
          row.toolCalls = row.toolCalls || []
          const exist = row.toolCalls.find((c) => c.id === p.id)
          if (exist) Object.assign(exist, p)
          else row.toolCalls.push(p)
          row.toolsOpen = row.toolsOpen === undefined ? true : row.toolsOpen
        }),

        // assistant 消息落库 → 换成正式行，补齐元信息
        bus.subscribe('message.appended', (p) => {
          if (p.role !== 'assistant') return
          const row = state.rows.find((r) => r.key === p.id) || state.rows.find((r) => r.pending && !r.text)
          if (!row) return
          row.key = p.id
          row.pending = false
          row.ms = p.ms
          row.usage = p.usage
          row.speed = p.speed
          row.cacheHit = p.cacheHit
          row.text = row.text || p.text
        }),

        // 出错 → 内联在末尾，不清空上文
        bus.subscribe('loop.run.failed', (p) => {
          state.sending = false
          state.failed = p.message
        }),

        // 取消 → 标记「已停止」，与正常结束区分开
        bus.subscribe('loop.run.cancelled', (p) => {
          state.sending = false
          const row = state.rows.find((r) => r.key === p.requestId)
          if (row) {
            row.pending = false
            row.stopped = true
          }
        }),
      )
    }

    bindEvents()

    return {
      state,
      bus,
      /** 发一条用户消息（对应 POST /api/command {topic:'loop.run'}） */
      send(text) {
        const turnKey = 'turn-' + Date.now()
        const id = 'msg-u-' + Date.now()
        bus.emit('message.appended', { id, role: 'user', text, turnKey })
        bus.emit('loop.state.changed', { requestId: 'req-' + Date.now(), state: 'running', turnKey, label: text.slice(0, 12) })
        return turnKey
      },
      dispose() {
        for (const d of disposers) d()
        disposers.length = 0
      },
    }
  }

  global.OST = global.OST || {}
  global.OST.state = { createChatState, bus }
})(window)
