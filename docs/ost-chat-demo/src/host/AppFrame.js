/**
 * AppFrame —— 宿主工作台的布局框架。
 *
 * 对应 osteosome `client/src/layouts/MainLayout.vue` +
 * `client/src/panes/default-layout.ts` 的 `chatThreeBoxRects`。
 *
 * ## 布局
 *
 * ```
 * ┌────┬──────────┬────────────────────────┬──────────┐
 * │ 轨 │ 会话列表  │ 对话流                   │ 检查器    │
 * │56px│ 240px    │ flex                    │ 300px    │
 * │    │          │ ┌──┬──────────────────┐  │          │
 * │    │          │ │导│ 消息区（滚动条在右）│  │          │
 * │    │          │ └──┴──────────────────┘  │          │
 * │    │          │ 输入区                    │          │
 * └────┴──────────┴────────────────────────┴──────────┘
 * ```
 *
 * 对话流**内部**再分两层：左 Turn 导航轨 + 右消息区。
 *
 * ## 组件边界
 *
 * AppFrame 只管**几何与显隐**，不知道盒子里是什么 widget。
 * 它对每个 widget id 调 `registry.resolveWidget()`，按 kind 决定怎么渲染：
 * local → 直接渲染组件；iframe → 交给 PluginWidgetHost；missing → 占位说明。
 *
 * 这条边界让「新增一个 widget」变成不需要改框架的事。
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h
  const computed = global.Vue.computed
  const UI = global.OST.ui
  const registry = global.OST.registry

  /** 布局规格 —— 每个槽位放哪些 widget id */
  const LAYOUT = [
    { slot: 'sessions', widgets: ['widget.session-list'], width: 240 },
    { slot: 'timeline', widgets: ['widget.chat-timeline'] },
    { slot: 'composer', widgets: ['widget.chat-composer'] },
    { slot: 'inspector', widgets: ['widget.session-workspace'], width: 300 },
  ]

  const AppFrame = {
    name: 'HostAppFrame',
    props: {
      /** 插件清单声明的视图 */
      pluginViews: { type: Array, default: () => [] },
      /** 每个 widget 的显隐状态 { widgetId: boolean } */
      hidden: { type: Object, default: () => ({}) },
      /** 传给插件视图的上下文（chat 实例等） */
      viewProps: { type: Object, default: () => ({}) },
    },
    setup(props) {
      /** 解析后的槽位 —— 计算出每个槽位实际要渲染什么 */
      const slots = computed(() =>
        LAYOUT.map((s) => ({
          ...s,
          items: s.widgets
            .filter((id) => !props.hidden[id])
            .map((id) => registry.resolveWidget(id, props.pluginViews)),
        }))
      )

      /**
       * 按 widget id 挑选该组件需要的 props。
       *
       * 共享的（chat / 事件回调）人人有；
       * 专属的（对话流的 rows/turns、输入框的 approval）只给对应组件。
       */
      function propsFor(id) {
        const v = props.viewProps
        const base = {
          chat: v.chat,
          currentSessionId: v.currentSessionId,
          onSend: v.onSend,
          onStop: v.onStop,
          onRegen: v.onRegen,
          onBranch: v.onBranch,
          onCopy: v.onCopy,
          onDelete: v.onDelete,
          onToggleThink: v.onToggleThink,
          onToggleTools: v.onToggleTools,
          onRequestApproval: v.onRequestApproval,
          onApprove: v.onApprove,
          onReject: v.onReject,
          onCloseApproval: v.onCloseApproval,
        }
        if (id === 'widget.chat-timeline') {
          return {
            ...base,
            rows: v.chat.state.rows,
            turns: v.chat.state.turns,
            activeTurnKey: v.chat.state.activeTurnKey,
            sending: v.chat.state.sending,
            failed: v.chat.state.failed,
          }
        }
        if (id === 'widget.chat-composer') {
          return { ...base }
        }
        if (id === 'widget.session-list') {
          return { ...base }
        }
        return base
      }

      return { slots, propsFor }
    },
    render() {
      const bySlot = {}
      for (const s of this.slots) bySlot[s.slot] = s

      /**
       * 渲染一个 widget。
       *
       * 每个 widget 拿到的 props 是**按自己的 id 挑过的** ——
       * 对话流要 rows/turns，输入框要 approval，检查器什么都不用。
       * 全部一股脑塞给所有 widget 的话，每个组件都得写一堆「不关心」的 props 判空。
       */
      const renderWidget = (w) => {
        if (w.kind === 'missing') {
          return h('div', { class: 'frame__missing' }, [
            h('p', { class: 'frame__missing-title' }, w.title + (w.reason === 'removed' ? ' 已被移除' : ' 未知组件')),
            h('p', { class: 'frame__missing-desc' }, 'widget id：' + w.id),
          ])
        }
        if (w.kind === 'iframe') {
          // 真实 osteosome 走这里：PluginWidgetHost 装载 /plugins/<id>/ui/<entry>
          return h('div', { class: 'frame__iframe-stub' }, [
            h('p', {}, 'iframe 视图：' + w.entry),
            h('p', { class: 'frame__missing-desc' }, '本 Demo 为纯前端参考，不做 iframe 装载'),
          ])
        }
        return h(w.component, this.propsFor(w.id))
      }

      const sessions = bySlot.sessions
      const timeline = bySlot.timeline
      const composer = bySlot.composer
      const inspector = bySlot.inspector

      // 显隐时收起对应列（用 data 属性驱动 CSS，避免 grid-template 重排闪烁）
      const frameData = {
        sessions: this.hidden['widget.session-list'] ? 'hidden' : 'shown',
        inspector: this.hidden['widget.session-workspace'] ? 'hidden' : 'shown',
      }

      return h('div', { class: 'frame', 'data-sessions': frameData.sessions, 'data-inspector': frameData.inspector }, [
        // 会话列表
        sessions && sessions.items.length
          ? h('div', { class: 'frame__sessions', style: { width: sessions.width + 'px' } }, sessions.items.map(renderWidget))
          : null,

        // 主区：对话流 + 输入区
        h('main', { class: 'frame__main' }, [
          h('div', { class: 'frame__timeline' }, timeline ? timeline.items.map(renderWidget) : null),
          h('div', { class: 'frame__composer' }, composer ? composer.items.map(renderWidget) : null),
        ]),

        // 检查器
        inspector && inspector.items.length
          ? h('div', { class: 'frame__inspector', style: { width: inspector.width + 'px' } }, inspector.items.map(renderWidget))
          : null,

        // 审批块 —— 独立浮层，盖在对话流上方
        // 不属于任何槽位，也不占布局空间
        this.viewProps.approvalVisible && this.viewProps.approval
          ? h('div', { class: 'frame__approval-layer' }, [
              h(global.OST.components.ApprovalPanel, {
                request: this.viewProps.approval,
                visible: true,
                onApprove: (ap) => this.viewProps.onApprove && this.viewProps.onApprove(ap),
                onReject: (ap) => this.viewProps.onReject && this.viewProps.onReject(ap),
                onClose: (ap) => this.viewProps.onCloseApproval && this.viewProps.onCloseApproval(ap),
              }),
            ])
          : null,
      ])
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.AppFrame = AppFrame
  global.OST.components.LAYOUT = LAYOUT
})(window)
