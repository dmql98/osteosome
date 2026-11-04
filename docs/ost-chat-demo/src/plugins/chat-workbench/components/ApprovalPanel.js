/**
 * 审批块 —— ApprovalPanel。
 *
 * 对应 osteosome `packages/client/ui-approval/src/client/ApprovalPanel.tsx`。
 *
 * ## 它是**独立弹出**的，不是对话流的一部分
 *
 * 当 Agent 请求授权时，这块面板从对话流**上方浮出**（不是插入消息流）。
 * 理由与 osteosome 相同：
 *
 * · 确认动作插进消息流会把线性叙事打断 —— 用户读了一半被打断
 * · 用户此刻的注意力在「这个操作要不要批」，不在「上一句话说了什么」
 * · 面板浮在流**上方**，视线不需要移动，也不需要滚动
 *
 * 所以它不属于对话流组件，是与工具调用联动的独立组件。
 *
 * ## 与工具的联动
 *
 * 联动的触发点在**工具调用树里**：某个工具调用带 `needsApproval` 时，
 * 该行右侧出现一个「待授权」标记，点击即弹出本面板。
 *
 * ```
 * 工具调用树                     审批块（浮出）
 * ┌────────────────────┐        ┌──────────────────┐
 * │ Read  session.ts ✓ │        │ ⚠ 等待授权        │
 * │ Bash  pnpm test  ⚠ │◀──点击──│ 允许执行 Bash…    │
 * │ Edit  token.ts  +12│        │ [拒绝][一次][始终] │
 * └────────────────────┘        │ 作用域：仅本会话…  │
 *                               └──────────────────┘
 * ```
 *
 * ## 关键设计：写清「始终允许」的作用域
 *
 * deepseek-harness 的审批卡有三个按钮，但「始终允许」的作用范围一个字都没说 ——
 * 用户点下去不知道自己在授权什么：哪个工具？哪个会话？永久还是临时？
 *
 * 这是**权限授予**，不是普通按钮。必须写明：工具 / 会话 / 有效期。
 *
 * ## 组件边界
 *
 * props：`request`（待审批项）/ `visible`
 * 事件：`approve` / `reject` / `close`
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h
  const UI = global.OST.ui

  const ApprovalPanel = {
    name: 'ChatApprovalPanel',
    props: {
      /**
       * 待审批项。
       * @type {{title:string,description:string,scope?:string,tool?:string}}
       * null 表示没有待审批项
       */
      request: { type: Object, default: null },
      /** 是否浮出 */
      visible: { type: Boolean, default: false },
    },
    emits: ['approve', 'reject', 'close'],
    setup(props, { emit }) {
      return () => {
        if (!props.request || !props.visible) return null
        const r = props.request
        return h('div', { class: 'approval-panel', role: 'dialog', 'aria-label': '等待授权' }, [
          h('div', { class: 'approval-panel__st' }, [
            h(UI.StatusDot, { state: 'listening', pulse: true }),
            '等待授权',
            h('button', {
              class: 'approval-panel__close',
              type: 'button',
              'aria-label': '关闭',
              onClick: () => emit('close', r),
            }, [
              h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' },
                [h('path', { d: 'M6 6l12 12M18 6L6 18' })]),
            ]),
          ]),
          h('h4', { class: 'approval-panel__title' }, r.title),
          h('p', { class: 'approval-panel__desc' }, r.description),
          h('div', { class: 'approval-panel__btns' }, [
            h(UI.Button, { variant: 'ghost', size: 'md', onClick: () => emit('reject', r) }, () => '拒绝'),
            h(UI.Button, { variant: 'ghost', size: 'md', onClick: () => emit('approve', r) }, () => '允许一次'),
            h(UI.Button, { variant: 'primary', size: 'md', onClick: () => emit('approve', r) }, () => '始终允许'),
          ]),
          // 权限范围说明 —— deepseek-harness 缺失的那一条
          h('p', { class: 'approval-panel__scope' }, [
            h('span', {}, r.scope || '作用域：仅本会话 · 30 分钟有效'),
            h('span', { class: 'approval-panel__keys' }, '⌘↵ 确认 · Esc 拒绝'),
          ]),
        ])
      }
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.ApprovalPanel = ApprovalPanel
})(window)
