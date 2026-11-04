/**
 * 宿主主装配 —— 对应 osteosome `client/src/main.ts` + `layouts/MainLayout.vue`。
 *
 * ## 它做的事
 *
 * 1. 装配顶栏与 AppFrame
 * 2. 持有 chat 状态实例，通过 props 传给插件视图
 * 3. 处理命令与事件（发送、停止、重新生成、删除、审批）
 *
 * ## 组件化收益在这层最明显
 *
 * 新增一个 widget 只需要两步，**不用改这个文件**：
 * · 写一个组件文件，在插件清单里 `registry.defineWidget(...)`
 * · 把 widget id 加进 `AppFrame` 的 `LAYOUT` 规格
 *
 * 这正是 osteosome「组件在原地换了实现，widget id 不变」的含义 ——
 * widget id 是持久化主键，改名会让用户拖好的位置全丢。
 */
;(function (global) {
  'use strict'

  const Vue = global.Vue
  const h = Vue.h
  const ref = Vue.ref
  const reactive = Vue.reactive
  const computed = Vue.computed

  const registry = global.OST.registry
  const C = global.OST.components

  /* ========================================================================
   * 主应用
   * ===================================================================== */
  const Root = {
    name: 'HostApp',
    setup() {
      const theme = ref('light')
      const density = ref('standard')
      const hidden = reactive({})
      const toastMsg = ref('')
      const chat = global.OST.state.createChatState()
      let toastTimer = null

      const toggles = [
        { id: 'widget.session-list', label: '会话列表', icon: 'sidebar' },
        { id: 'widget.session-workspace', label: '检查器', icon: 'panel' },
      ]

      function toast(text) {
        toastMsg.value = text
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => (toastMsg.value = ''), 1900)
      }

      function applyTheme(next) {
        theme.value = next
        document.documentElement.setAttribute('data-theme', next)
      }

      /**
       * 待审批项 —— 从工具调用里提取。
       *
       * **审批块是独立浮层**，不是对话流的一部分：
       * 触发点在工具调用树的行上（该行带 needsApproval），
       * 用户点击后才浮出。浮层盖在对话流上方，不插入消息流。
       */
      const approval = computed(() => {
        for (const row of chat.state.rows) {
          for (const c of row.toolCalls || []) {
            if (c.needsApproval && !c.approved) return c
          }
        }
        return null
      })

      /** 审批块是否浮出 */
      const approvalVisible = ref(false)

      /** 工具调用请求授权 —— 弹出审批块 */
      function requestApproval(call) {
        chat.state.approvalTarget = call
        approvalVisible.value = true
      }

      /**
       * 模拟一次 run —— 顶替真实 SSE 的 token 推送。
       *
       * 载荷形状与真实事件一致，所以换成真 SSE 时这段可以整段删掉，
       * 只需把 `bus.emit` 换成 `sse.subscribe` 的回调。
       */
      function simulateRun(userText, turnKey) {
        const bus = global.OST.state.bus
        const requestId = 'req-' + Date.now()
        const t0 = Date.now()

        setTimeout(() => {
          bus.emit('loop.state.changed', { requestId, state: 'running', turnKey, label: userText.slice(0, 12) })

          // 思考块
          const reasoning = '灰度开关应放在网关层：前端只读一个能力位，网关按位摘流量，前端无需发版即可降级。'
          let i = 0
          const step = () => {
            if (i < reasoning.length) {
              const chunk = reasoning.slice(i, i + 3)
              i += 3
              bus.emit('loop.token.streamed', { requestId, token: chunk, blockType: 'reasoning', elapsedMs: Date.now() - t0 })
              setTimeout(step, 26)
            }
          }
          step()

          // 工具调用
          setTimeout(() => {
            bus.emit('loop.tool.executed', {
              requestId, id: 'tc-1', name: 'Read', icon: '▤',
              path: 'src/auth/session.ts', ok: true, ms: 420,
              children: [{ name: 'Grep', args: '"getSessionToken"', summary: '3 matches' }],
            })
            bus.emit('loop.tool.executed', {
              requestId, id: 'tc-2', name: 'Edit', icon: '✎',
              path: 'src/auth/token.ts', ok: true, ms: 1180,
              diff: { add: 12, del: 3 },
            })
            bus.emit('loop.tool.executed', {
              requestId, id: 'tc-3', name: 'Bash', icon: '▶',
              path: 'pnpm test --run auth', ok: undefined, ms: 0,
              needsApproval: true,
              title: '允许执行 Bash：pnpm test --run auth',
              description: '该命令会写入 fixtures/ 并触发 2 个集成测试。',
              scope: '作用域：仅本会话 · 仅 Bash 工具 · 30 分钟有效',
              tool: 'Bash',
            })
          }, 900)

          // 正文 token
          const body = '正在把 Session 解析替换为 Token 校验，涉及 4 个文件、12 处改动，先改 middleware，再补灰度开关与回滚端点。'
          let j = 0
          const bodyStep = () => {
            if (j < body.length) {
              const chunk = body.slice(j, j + 2)
              j += 2
              bus.emit('loop.token.streamed', { requestId, token: chunk, blockType: 'text' })
              setTimeout(bodyStep, 18)
            } else {
              const ms = Date.now() - t0
              bus.emit('message.appended', {
                id: 'msg-a-' + Date.now(), role: 'assistant', text: body,
                ms, usage: { prompt: 8200, completion: 642 }, speed: 34, cacheHit: 74,
              })
              bus.emit('loop.state.changed', { requestId, state: 'idle' })
            }
          }
          setTimeout(bodyStep, 1500)
        }, 120)
      }

      function send(text) {
        const turnKey = chat.send(text)
        simulateRun(text, turnKey)
      }

      function stop() {
        const bus = global.OST.state.bus
        const row = [...chat.state.rows].reverse().find((r) => r.pending)
        if (row) bus.emit('loop.run.cancelled', { requestId: row.key })
        toast('已停止生成')
      }

      /** 重新生成 —— 原地执行，不新建会话（补两个项目共同缺的） */
      function regen(row) {
        if (chat.state.sending) return
        chat.state.rows = chat.state.rows.filter((r) => r.key !== row.key)
        const users = chat.state.rows.filter((r) => r.role === 'user')
        const anchor = users[users.length - 1]
        if (anchor) simulateRun(anchor.text, anchor.key)
        toast('已重新生成（原地替换，未新建会话）')
      }

      function branch() { toast('已从此消息创建分支会话，原会话保持不变') }

      async function copy(row) {
        try { await navigator.clipboard.writeText(row.text); toast('已复制') } catch (e) { toast('复制失败') }
      }

      function del(row) {
        if (!confirm('删除这条消息？此操作会截断其后的对话，且不可撤销。')) return
        chat.state.rows = chat.state.rows.filter((r) => r.key !== row.key)
        toast('已删除')
      }

      function toggleThink(key) {
        const row = chat.state.rows.find((r) => r.key === key)
        if (row) row.thinkingOpen = row.thinkingOpen === false
      }

      function toggleTools(key) {
        const row = chat.state.rows.find((r) => r.key === key)
        if (row) row.toolsOpen = !row.toolsOpen
      }

      function approve(ap) {
        ap.approved = true; ap.needsApproval = false; ap.ok = true; ap.summary = '已授权'
        approvalVisible.value = false
        toast('已授权（30 分钟 / 仅本会话）')
      }

      function reject(ap) {
        ap.approved = true; ap.needsApproval = false; ap.ok = false; ap.summary = '已拒绝'
        approvalVisible.value = false
        toast('已拒绝')
      }

      /** 传给插件视图的 props —— 宿主显式注入，不让视图读全局 store */
      const viewProps = computed(() => ({
        chat: chat,
        approval: approval.value,
        approvalVisible: approvalVisible.value,
        currentSessionId: 's1',
        onSend: send,
        onStop: stop,
        onRegen: regen,
        onBranch: branch,
        onCopy: copy,
        onDelete: del,
        onToggleThink: toggleThink,
        onToggleTools: toggleTools,
        onApprove: approve,
        onReject: reject,
        onRequestApproval: requestApproval,
        onCloseApproval: () => (approvalVisible.value = false),
      }))

      return {
        theme, density, hidden, toastMsg, chat, toggles, viewProps,
        approvalVisible,
        pluginViews: global.OST.plugin.views,
        applyTheme,
      }
    },
    render() {
      return h('div', { class: 'host' }, [
        h(C.AppFrame, {
          pluginViews: this.pluginViews,
          hidden: this.hidden,
          viewProps: this.viewProps,
        }),

        this.toastMsg ? h('div', { class: 'host__toast' }, this.toastMsg) : null,
      ])
    },
  }

  /* ========================================================================
   * 启动
   * ===================================================================== */
  const container = document.getElementById('app')
  if (!container) throw new Error('#app not found')
  Vue.createApp(Root).mount(container)

  /**
   * 首屏演示数据 —— 真实实现里来自 SSE。
   *
   * 三轮对话，好让左侧 Turn 导航轨有多个刻度可看。
   */
  global.OST.__seed = function () {
    const bus = global.OST.state.bus

    function turn(n, userText, label, reasoning, tools, body, meta) {
      bus.emit('message.appended', { id: 'msg-u-' + n, role: 'user', text: userText, turnKey: 'turn-' + n })
      bus.emit('loop.state.changed', { requestId: 'req-' + n, state: 'running', turnKey: 'turn-' + n, label })
      if (reasoning) bus.emit('loop.token.streamed', { requestId: 'req-' + n, token: reasoning, blockType: 'reasoning', elapsedMs: 1800 })
      for (const t of tools || []) bus.emit('loop.tool.executed', { requestId: 'req-' + n, ...t })
      bus.emit('loop.token.streamed', { requestId: 'req-' + n, token: body, blockType: 'text' })
      bus.emit('message.appended', { id: 'msg-a-' + n, role: 'assistant', text: body, ...meta })
      bus.emit('loop.state.changed', { requestId: 'req-' + n, state: 'idle' })
    }

    setTimeout(() => {
      turn(1,
        '帮我把鉴权层从 Session 换成 Token，且灰度要可回滚。',
        '鉴权层迁移',
        '先确认一个前提：鉴权层的迁移不只是把 Session 换成 Token，两者的失效语义不同。',
        [
          { id: 'tc-s1', name: 'Read', icon: '▤', path: 'src/auth/session.ts', ok: true, ms: 420 },
          { id: 'tc-s2', name: 'Edit', icon: '✎', path: 'src/auth/token.ts', ok: true, ms: 1180, diff: { add: 12, del: 3 } },
        ],
        'Session 是自然过期，Token 是被吊销。后者需要主动通知前端，否则会留下「看似有效、实则已失效」的中间态。',
        { ms: 12400, usage: { prompt: 8200, completion: 1200 }, speed: 38, cacheHit: 74 })

      turn(2,
        '那灰度开关放哪一层？前端要能自己降级。',
        '灰度开关位置',
        '灰度开关应放在网关层：前端只读一个能力位，网关按位摘流量。',
        [
          { id: 'tc-s3', name: 'Grep', icon: '⌕', path: '"capability"', ok: true, ms: 260,
            children: [{ name: 'Read', args: 'src/gateway/capability.ts', summary: '42 lines' }] },
          { id: 'tc-s4', name: 'Write', icon: '✎', path: 'src/gateway/capability.ts', ok: true, ms: 890, diff: { add: 24, del: 6 } },
        ],
        '放在网关层。前端只读一个能力位，不做判断；网关按位摘流量，回滚就是把位改回去——前端无需发版。',
        { ms: 8300, usage: { prompt: 9100, completion: 780 }, speed: 41, cacheHit: 81 })

      turn(3,
        '回滚端点怎么设计？',
        '回滚端点',
        null,
        [
          { id: 'tc-s5', name: 'Read', icon: '▤', path: 'src/gateway/route.ts', ok: true, ms: 310 },
        ],
        '回滚端点只做一件事：把能力位从 active 改回 passive，并广播给所有已连接的会话。幂等、可重复调用。',
        { ms: 6100, usage: { prompt: 10200, completion: 520 }, speed: 44, cacheHit: 86 })
    }, 400)
  }
})(window)
