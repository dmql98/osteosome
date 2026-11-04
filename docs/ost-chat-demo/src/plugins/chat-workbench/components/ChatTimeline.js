/**
 * 对话流 —— ChatTimeline。
 *
 * ## 这是「一个组件」，不是五个
 *
 * 思考块、对话框、Turn 导航轨、工具调用树、统计栏 —— 它们是对话流的**内部构造**，
 * 不是五个平级的顶层组件。它们的展开策略各自独立（思考默认展开 / 工具默认折叠 /
 * 统计常驻但操作按钮 hover 才显形 / 导航轨跟随滚动），
 * 所以内部拆成子组件是对的；但对外**只暴露一个 ChatTimeline**。
 *
 * 理由：widget 是宿主摆位的单位。用户拖动的、面板里放着的，是「对话流」这一个盒子，
 * 不是五个。拆成五个 widget 意味着用户要自己拼 —— 那是另一个产品的形态。
 *
 * ## 组成
 *
 * ```
 * ┌──┬────────────────────────────────┐
 * │导│  消息区（原生滚动条在右侧）        │
 * │航│                                │
 * │轨│  ┌ 思考块（可折叠）              │
 * │26│  ├ 工具调用树（可折叠）          │
 * │px │  └ 对话框（正文 + 呼吸光标）      │
 * │   │       └ 统计栏（耗时/token/操作） │
 * └──┴────────────────────────────────┘
 * ```
 *
 * ## 与 osteosome 的对应
 *
 * 真实实现里这些会拆成 `ChatTimelineView.vue` + `ThinkingBlock.vue` +
 * `ToolCallTree.vue` + `MessageBubble.vue` + `TurnNavRail.vue` 等多个文件
 * （放在 `packages/client/ui-chat/` 与 `ui-tool/` 两个包里）。
 * 本 Demo 合成一个文件是为了**看清它们的装配关系** ——
 * 实际开发时按这个边界拆开即可，props/emits 契约不变。
 *
 * ## 组件边界
 *
 * props：`rows` / `turns` / `activeTurnKey` / `sending` / `failed`
 * 事件：`jump` / `regen` / `branch` / `copy` / `delete` / `toggle-think` / `toggle-tools`
 */

;(function (global) {
  'use strict'

  const h = global.Vue.h
  const Vue_computed = global.Vue.computed
  const UI = global.OST.ui

  /**
   * 子组件在**本文件末尾**才注册到 global.OST.components，
   * 所以这里不能顶部捕获快照 —— 渲染时才查，那时都注册好了。
   */
  function C() { return global.OST.components }

  /**
   * 消息操作行的图标。
   *
   * 提到模块级 —— StatBar 的 render 与 MessageBubble 都要用它，
   * 放在某个组件的 setup 里另一个组件看不到。
   */
  function icon(name) {
    const paths = {
      copy: 'M9 9h11v11H9z M5 15V5h10',
      regen: 'M20 12a8 8 0 1 1-2.3-5.6 M20 4v7h-7',
      branch: 'M6 4v16 M6 8c0 3 3 3 8 3 M6 4a1.5 1.5 0 1 0 0 .01 M18 11a1.5 1.5 0 1 0 0 .01',
      trash: 'M4 7h16 M9 7V5h6v2 M6 7l1 13h10l1-13',
    }
    return h('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, [h('path', { d: paths[name] })])
  }

  const ThinkingBlock = {
      name: 'ChatThinkingBlock',
      props: {
        /** 思维链正文（不含正文） */
        reasoning: { type: String, default: '' },
        /** 思考耗时（毫秒） */
        durationMs: { type: Number, default: 0 },
        /** 是否展开 —— 受控，由父组件持有状态 */
        open: { type: Boolean, default: true },
      },
      emits: ['toggle'],
      setup(props, { emit }) {
        return () => {
          if (!props.reasoning) return null
          return h('div', { class: 'msg-think' }, [
            h('button', {
              class: 'msg-think__head',
              type: 'button',
              'aria-expanded': props.open ? 'true' : 'false',
              onClick: () => emit('toggle'),
            }, [
              h('span', { class: 'msg-think__icon', 'aria-hidden': 'true' }, '◈'),
              h('span', {}, '思考'),
              props.durationMs ? h('span', { class: 'msg-think__time' }, '· ' + (props.durationMs / 1000).toFixed(1) + 's') : null,
              h('span', { class: 'msg-think__chev', 'aria-hidden': 'true' }, props.open ? '▾' : '▸'),
            ]),
            props.open ? h('div', { class: 'msg-think__body' }, props.reasoning) : null,
          ])
        }
      },
    }

  const ToolCallTree = {
      name: 'ChatToolCallTree',
      props: {
        /** @type {Array} 工具调用列表 */
        calls: { type: Array, default: () => [] },
        /** 展开状态（受控） */
        open: { type: Boolean, default: true },
        /** 本组总耗时（毫秒） */
        durationMs: { type: Number, default: 0 },
      },
      emits: ['toggle', 'approve', 'reject'],
      setup(props, { emit }) {
        const running = () => props.calls.some((c) => c.ok === undefined)

        /** 折叠组标题：按活动摘要生成，不写死 */
        function title() {
          const names = props.calls.map((c) => c.name)
          if (!names.length) return '工具执行'
          const head = names.slice(0, 2).join('、')
          return names.length > 2 ? head + ' 等 ' + names.length + ' 步' : head
        }

        function renderRow(c) {
          const children = c.children || []
          const needsApproval = c.needsApproval && !c.approved
          return h('div', {
            class: ['msg-tool', { 'msg-tool--pending': needsApproval }],
          }, [
            h('div', {
              class: ['msg-tool__row', { 'msg-tool__row--actionable': needsApproval }],
              // 需要授权的行整行可点 —— 点击即弹出审批块（独立浮层，不插入消息流）
              onClick: needsApproval ? () => emit('request-approval', c) : undefined,
              role: needsApproval ? 'button' : undefined,
              tabindex: needsApproval ? 0 : undefined,
              title: needsApproval ? '点击处理授权请求' : undefined,
            }, [
              h('span', { class: 'msg-tool__icon', 'aria-hidden': 'true' }, c.icon || '▤'),
              h('span', { class: 'msg-tool__name' }, c.name),
              h('span', { class: 'msg-tool__path' }, c.path || c.args || ''),
              h('span', { class: 'msg-tool__right' }, [
                c.diff
                  ? h('span', { class: 'msg-tool__diff' }, [
                      h('span', { class: 'is-add' }, '+' + c.diff.add),
                      h('span', { class: 'is-del' }, '−' + c.diff.del),
                    ])
                  : null,
                // 待授权标记 —— 审批块由它触发
                needsApproval
                  ? h('span', { class: 'msg-tool__pending' }, [
                      h(UI.StatusDot, { state: 'listening', pulse: true }),
                      '待授权',
                    ])
                  : null,
                c.ok === undefined && !needsApproval ? h(UI.Spinner, { size: 11 }) : null,
                c.ok === true ? h('span', { class: 'msg-tool__ok', 'aria-label': '成功' }, '✓') : null,
                c.ok === false ? h('span', { class: 'msg-tool__fail', 'aria-label': '失败' }, '✗') : null,
              ]),
            ]),

            // 子调用挂 0.5px 竖线 —— 表达血缘
            children.length
              ? h('div', { class: 'msg-tool__children' },
                  children.map((child) =>
                    h('div', { class: 'msg-tool__row msg-tool__row--sub', key: child.name }, [
                      h('span', { class: 'msg-tool__icon', 'aria-hidden': 'true' }, child.icon || '⌕'),
                      h('span', { class: 'msg-tool__name msg-tool__name--sub' }, child.name),
                      h('span', { class: 'msg-tool__path' }, child.args || ''),
                      h('span', { class: 'msg-tool__right' }, child.summary || ''),
                    ])
                  ))
              : null,
          ])
        }


        return () => {
          if (!props.calls.length) return null
          const isRunning = running()
          return h('div', { class: 'msg-tools' }, [
            h('button', {
              class: 'msg-tools__head',
              type: 'button',
              'aria-expanded': props.open ? 'true' : 'false',
              onClick: () => emit('toggle'),
            }, [
              h('span', { class: 'msg-tools__chev', 'aria-hidden': 'true' }, props.open ? '▾' : '▸'),
              h('span', {}, title()),
              h(UI.Badge, { tone: isRunning ? 'primary' : 'success', size: 'sm' }, () => (isRunning ? '进行中' : '已完成')),
              h('span', { class: 'msg-tools__time' }, (props.durationMs / 1000).toFixed(1) + 's'),
            ]),
            props.open
              ? h('div', { class: 'msg-tools__list' }, props.calls.map((c) => renderRow(c)))
              : null,
          ])
        }
      },
    }

  const StatBar = {
      name: 'ChatStatBar',
      props: {
        /** LLM 耗时（毫秒） */
        ms: { type: Number, default: null },
        /** token 用量 */
        usage: { type: Object, default: null },   // { prompt, completion }
        /** 输出速度（tok/s） */
        speed: { type: Number, default: null },
        /** 缓存命中率（%） */
        cacheHit: { type: Number, default: null },
        /** 是否在途（在途时不显示耗时） */
        pending: { type: Boolean, default: false },
        /** 是否被中断 */
        stopped: { type: Boolean, default: false },
        /** 是否显示操作按钮 */
        actions: { type: Boolean, default: true },
        /** 是否是助手消息（决定有哪些操作） */
        role: { type: String, default: 'assistant' },
      },
      emits: ['copy', 'regen', 'branch', 'delete'],
      setup(props, { emit }) {
        return () => {
          const items = []
          // 在途时不显示耗时 —— 那时候还没有
          if (props.ms != null && !props.pending) items.push((props.ms / 1000).toFixed(1) + 's')
          if (props.usage) items.push(props.usage.prompt + ' → ' + props.usage.completion + ' tok')
          if (props.speed) items.push(props.speed + ' tok/s')
          if (props.cacheHit != null) items.push('缓存命中 ' + props.cacheHit + '%')

          if (!items.length && !props.actions) return null

          return h('div', { class: 'msg-meta' }, [
            ...items.map((t, i) => h('span', { class: 'msg-meta__item', key: i }, t)),
            props.stopped ? h('span', { class: 'msg-meta__stopped' }, '已停止') : null,
            props.actions
              ? h('div', { class: 'msg-actions' }, [
                  h(UI.IconButton, { label: '复制', size: 'sm', onClick: () => emit('copy') }, () => icon('copy')),
                  props.role === 'assistant'
                    ? h(UI.IconButton, { label: '重新生成 ⌘⇧R', size: 'sm', onClick: () => emit('regen') }, () => icon('regen'))
                    : null,
                  h(UI.IconButton, { label: '从此分支', size: 'sm', onClick: () => emit('branch') }, () => icon('branch')),
                  h(UI.IconButton, { label: '删除', size: 'sm', onClick: () => emit('delete') }, () => icon('trash')),
                ])
              : null,
          ])
        }
      },
    }

  const MessageBubble = {
      name: 'ChatMessageBubble',
      props: {
        /** @type {{key:string,role:'user'|'assistant',text:string,pending?:boolean}} */
        row: { type: Object, required: true },
        /** 是否是本轮最后一条 */
        isLast: { type: Boolean, default: false },
      },
      emits: ['regen', 'branch', 'copy', 'delete', 'toggle-think', 'toggle-tools', 'request-approval'],
      setup(props, { emit }) {
        function bubbleClass() {
          return props.row.role === 'user'
            ? 'msg-bubble msg-bubble--user'
            : 'msg-bubble msg-bubble--assistant'
        }

        return () => {
          const r = props.row
          const isUser = r.role === 'user'

          return h('article', {
            class: ['msg', 'msg--' + r.role, { 'is-streaming': r.pending }],
            'data-testid': 'timeline-' + r.role,
          }, [
            // 助手消息：思考块在正文之上
            !isUser && r.reasoning
              ? h(C().ThinkingBlock, {
                  reasoning: r.reasoning,
                  durationMs: r.reasoningMs,
                  open: r.thinkingOpen !== false,
                  onToggle: () => emit('toggle-think', r.key),
                })
              : null,

            // 助手消息：工具调用树
            !isUser && r.toolCalls && r.toolCalls.length
              ? h(C().ToolCallTree, {
                  calls: r.toolCalls,
                  open: r.toolsOpen !== false,
                  durationMs: (r.toolCalls || []).reduce((s, c) => s + (c.ms || 0), 0),
                  onToggle: () => emit('toggle-tools', r.key),
                onRequestApproval: (c) => emit('request-approval', c),
                })
              : null,

            // 正文气泡
            h('div', { class: bubbleClass() }, [
              r.pending && !r.text
                ? h('span', { class: 'msg-bubble__spinner' }, '◌')
                : null,
              r.text ? h('div', { class: 'msg-bubble__text' }, r.text) : null,
              // 呼吸光标 —— 回答「还在写还是卡了」
              r.pending && r.text
                ? h('span', { class: 'msg-caret', 'aria-hidden': 'true', 'data-testid': 'timeline-caret' })
                : null,
            ]),

            // 统计栏
            !isUser
              ? h(C().StatBar, {
                  ms: r.ms,
                  usage: r.usage,
                  speed: r.speed,
                  cacheHit: r.cacheHit,
                  pending: r.pending,
                  stopped: r.stopped,
                  role: r.role,
                  onCopy: () => emit('copy', r),
                  onRegen: () => emit('regen', r),
                  onBranch: () => emit('branch', r),
                  onDelete: () => emit('delete', r),
                })
              : null,
          ])
        }
      },
    }

  const TurnNavRail = {
      name: 'ChatTurnNavRail',
      props: {
        /** @type {Array<{key:string,label:string,active?:boolean}>} */
        turns: { type: Array, default: () => [] },
        /** 当前视口所处的 turn key */
        activeKey: { type: String, default: '' },
        /** 轨道的最大高度（px），超出则等比压缩刻度间距 */
        maxHeight: { type: Number, default: 0 },
      },
      emits: ['jump'],
      setup(props, { emit }) {
        /**
         * 刻度高度按轨道可用高度自适应：
         * 轮次少时每格固定 18px（疏朗可点），轮次多时压缩到 8px（仍可点）。
         *
         * maxHeight 由宿主（ChatTimelineView）用 ResizeObserver 量出来传进来 ——
         * 组件自己不读 DOM（保持纯展示）。
         */
        function step() {
          const n = props.turns.length
          if (!n) return 18
          if (!props.maxHeight) return 18
          return Math.max(8, Math.min(18, Math.floor((props.maxHeight - 8) / n)))
        }

        return () => {
          if (!props.turns.length) return null
          const s = step()
          return h(
            'nav',
            {
              class: 'turn-nav',
              'aria-label': '对话轮次导航',
              style: { '--turn-step': s + 'px' },
            },
            props.turns.map((t) =>
              h(
                'button',
                {
                  key: t.key,
                  class: ['turn-nav__tick', { 'is-active': t.key === props.activeKey }],
                  type: 'button',
                  title: t.label,
                  'aria-label': '跳到：' + t.label,
                  'aria-current': t.key === props.activeKey ? 'true' : undefined,
                  'data-index': props.turns.indexOf(t) + 1,
                  onClick: () => emit('jump', t.key),
                },
                h('span', { class: 'turn-nav__tip' }, t.label)
              )
            )
          )
        }
      },
    }

    /* ========================================================================
     * 对话流 —— 对外唯一的顶层组件
     * ===================================================================== */
  const ChatTimeline = {
    name: 'ChatTimeline',
    props: {
      /** @type {Array} 消息行 */
      rows: { type: Array, default: () => [] },
      /** @type {Array} 轮次导航条目 { key, label } */
      turns: { type: Array, default: () => [] },
      /** 当前视口所处的轮次 */
      activeTurnKey: { type: String, default: '' },
      /** 是否在途 */
      sending: { type: Boolean, default: false },
      /** 错误信息（内联在末尾） */
      failed: { type: String, default: '' },
      /** 导航轨可用高度（0 = 未测量） */
      navMaxHeight: { type: Number, default: 0 },
    },
    emits: ['jump', 'regen', 'branch', 'copy', 'delete', 'toggle-think', 'toggle-tools', 'request-approval'],
    setup(props, { emit }) {
      /**
       * 按 Turn 分组渲染 —— user 行开启一个新 Turn，assistant 行归属上一个。
       * 这样导航轨的刻度与消息分组是同一套结构，不需要额外映射表。
       */
      const groups = Vue_computed(() => {
        const out = []
        let cur = null
        for (const row of props.rows) {
          if (row.role === 'user' || !cur) {
            cur = { key: row.key, rows: [row] }
            out.push(cur)
          } else {
            cur.rows.push(row)
          }
        }
        return out
      })

      const turnItems = Vue_computed(() =>
        props.turns.map((t) => ({ key: t.key, label: t.label }))
      )

      return { groups, turnItems }
    },
    render() {
      const s = this
      return h('div', { class: 'ctv' }, [
        // 主体：左导航轨 + 右消息区
        h('div', { class: 'ctv__body' }, [
          h(C().TurnNavRail, {
            turns: this.turnItems,
            activeKey: this.activeTurnKey,
            maxHeight: this.navMaxHeight,
            onJump: (k) => s.$emit('jump', k),
          }),

          h('div', { class: 'ctv__scroll', 'data-testid': 'timeline-scroll' }, [
            this.rows.length === 0
              ? h(UI.EmptyState, {
                  icon: '💬',
                  title: '这个会话还没有消息',
                  description: '在下方输入框发问，会话会自动保存历史。',
                })
              : null,

            this.groups.map((g) =>
              h('section', { class: 'ctv__turn', key: g.key, 'data-turn': g.key },
                g.rows.map((row, i) =>
                  h(C().MessageBubble, {
                    row: row,
                    isLast: i === g.rows.length - 1,
                    onRegen: (r) => s.$emit('regen', r),
                    onBranch: (r) => s.$emit('branch', r),
                    onCopy: (r) => s.$emit('copy', r),
                    onDelete: (r) => s.$emit('delete', r),
                    onToggleThink: (k) => s.$emit('toggle-think', k),
                    onToggleTools: (k) => s.$emit('toggle-tools', k),
                    onRequestApproval: (c) => s.$emit('request-approval', c),
                  })
                )
              )
            ),

            this.failed
              ? h('div', { class: 'ctv__failed', 'data-testid': 'timeline-failed' }, this.failed)
              : null,
          ]),
        ]),
      ])
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.ChatTimeline = ChatTimeline
  global.OST.components.ThinkingBlock = ThinkingBlock
  global.OST.components.ToolCallTree = ToolCallTree
  global.OST.components.StatBar = StatBar
  global.OST.components.MessageBubble = MessageBubble
  global.OST.components.TurnNavRail = TurnNavRail
})(window)
