/**
 * ChatComposerView —— 输入区。
 *
 * 对应 osteosome `plugins/chat-workbench/ui/src/views/ChatComposerView.vue`。
 *
 * ## 关键设计：常驻（Resident）
 *
 * osteosome 的输入框是「常驻」的 —— 从空会话到有会话，**textarea 不重挂载**，
 * 于是草稿、光标位置、输入法状态全部保留。
 *
 * 本 Demo 用同一个组件实例在两个阶段之间切换，而不是 v-if 两套 DOM：
 * `phase` 变的是样式与占位符，不是节点本身。
 *
 * ## 审批接管（Composer Takeover）
 *
 * 当 Agent 请求授权时，**输入框就地变成确认卡片**，而不是在消息流里插一张卡。
 * 理由与 osteosome 相同：确认动作插进消息流会把线性叙事打断，
 * 而用户此刻的注意力在「我要说什么 / 我要不要批准」之间，
 * 让输入框原地变成审批卡，视线不需要移动。
 *
 * 但与 osteosome 有一处不同：osteosome 是三个 iframe，
 * 审批时**消息流不渲染占位**（`ChatView.tsx` 有明确注释：
 * 「questions 与 approvals 都接管 composer，所以 flow card 会重复渲染同一个等待」）。
 * 本 Demo 是单页，所以消息流里的工具行**也会**显示审批提示 ——
 * 这不是 bug，是单页形态下的信息冗余。真实实现里要去掉流内的那一份。
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h
  const ref = global.Vue.ref
  const computed = global.Vue.computed
  const nextTick = global.Vue.nextTick
  const UI = global.OST.ui

  const ChatComposerView = {
    name: 'ChatComposerView',
    props: {
      chat: { type: Object, required: true },
    },
    emits: ['send', 'stop'],
    setup(props, { emit }) {
      const draft = ref('')
      /** textarea 元素引用（用于自动增高） */
      const textareaRef = ref(null)
      const phase = computed(() => (props.chat.state.rows.length ? 'active' : 'hero'))

      function autoGrow() {
        const el = textareaRef.value
        if (!el) return
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 180) + 'px'
      }

      function onKeydown(e) {
        // Enter 发送 / Shift+Enter 换行 —— 且屏蔽输入法组合态
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          doSend()
        }
        // ↑ 调出上一条用户输入
        if (e.key === 'ArrowUp' && !draft.value.trim()) {
          e.preventDefault()
          const last = [...props.chat.state.rows].reverse().find((r) => r.role === 'user')
          if (last) {
            draft.value = last.text
            nextTick(autoGrow)
          }
        }
      }

      function doSend() {
        const text = draft.value.trim()
        if (!text || props.chat.state.sending) return
        emit('send', text)
        draft.value = ''
        nextTick(autoGrow)
      }

      function onPaste(e) {
        // 粘贴文件 → 附件 rail（此处仅提示）
        const items = e.clipboardData && e.clipboardData.files
        if (items && items.length) e.preventDefault()
      }

      nextTick(autoGrow)

      /**
       * render 是独立于 setup 的函数，拿不到 setup 的局部变量。
       * 所以元素引用通过 setter 暴露出去 —— 与 ChatTimelineView 同一手法。
       */
      function setTextarea(el) { textareaRef.value = el }

      return { draft, phase, autoGrow, onKeydown, doSend, onPaste, setTextarea }
    },
    render() {
      const s = this.chat.state

      return h('div', { class: ['ccv', 'ccv--' + this.phase] }, [
        h('div', { class: 'ccv__card' }, [
          h('textarea', {
            class: 'ccv__input',
            'data-testid': 'composer-input',
            ref: (el) => { this.setTextarea(el) },
            rows: 1,
            value: this.draft,
            placeholder: '说点什么…  @ 引用文件 · / 命令 · ⌘K 命令面板',
            onInput: (e) => { this.draft = e.target.value; this.autoGrow() },
            onKeydown: (e) => this.onKeydown(e),
            onPaste: (e) => this.onPaste(e),
          }),
          h('div', { class: 'ccv__bar' }, [
            h('button', { class: 'ccv__chip', type: 'button' }, [
              h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round' },
                [h('path', { d: 'M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10 18.5a2 2 0 0 1-3-3l8-8' })]),
              '附件',
            ]),
            h('button', { class: 'ccv__chip', type: 'button' }, '@ 引用'),
            h('button', { class: 'ccv__chip ccv__chip--act', type: 'button' }, '计划模式'),

            // 上下文占用环
            h('div', { class: 'ccv__ctx', title: '上下文占用 34%' }, [
              h('svg', { width: 17, height: 17, viewBox: '0 0 36 36' }, [
                h('circle', { cx: 18, cy: 18, r: 15, fill: 'none', stroke: 'var(--color-border-soft)', 'stroke-width': 4 }),
                h('circle', { cx: 18, cy: 18, r: 15, fill: 'none', stroke: 'var(--color-primary)', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': '32 94', transform: 'rotate(-90 18 18)' }),
              ]),
              h('span', { class: 'ccv__ctx-lab' }, '上下文 34%'),
            ]),

            // 发送 / 停止 —— 同一颗按钮的两种形态
            s.sending
              ? h(UI.Button, { variant: 'danger', size: 'md', onClick: () => this.$emit('stop') }, () => [h('span', { class: 'ccv__stop-ico' })])
              : h('button', {
                  class: 'ccv__send',
                  type: 'button',
                  disabled: !this.draft.trim(),
                  'aria-label': '发送 (Enter)',
                  onClick: () => this.doSend(),
                }, [
                  h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
                    [h('path', { d: 'M12 20V6M6 12l6-6 6 6' })]),
                ]),
          ]),
        ]),
        h('div', { class: 'ccv__hint' }, [
          'Enter 发送 · Shift+Enter 换行 · ',
          h('kbd', {}, 'Esc'),
          ' 停止生成 · ',
          h('kbd', {}, '↑'),
          ' 编辑上一条',
        ]),
      ])
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.ChatComposerView = ChatComposerView
})(window)
