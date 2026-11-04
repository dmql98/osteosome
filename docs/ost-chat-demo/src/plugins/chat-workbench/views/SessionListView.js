/**
 * SessionListView —— 会话列表。
 *
 * 对应 osteosome `plugins/chat-workbench/ui/src/views/SessionListView.vue`。
 *
 * ## 状态点：运行态的唯一表达
 *
 * 每行会话右侧一个 7px 圆点，颜色与脉动频率表示这一轮在干什么
 * （thinking / working / speaking / success / error）。
 * 这套色值来自 `--motion-*` 令牌 —— 深浅两套各自取值，
 * 硬编码十六进制在深色下会糊。
 *
 * ## 分组
 *
 * 按「今天 / 昨天 / 更早」分组。分组是**展示层**的切分，
 * 不影响底层数据 —— 数据仍然是扁平的会话数组。
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h
  const UI = global.OST.ui

  /** 演示数据 —— 真实实现里来自 SSE `session.created/updated/deleted` */
  const SESSIONS = [
    { id: 's1', title: '鉴权层迁移方案', preview: '12:04 · 42 条消息', group: '今天', state: 'thinking', current: true },
    { id: 's2', title: '会话流 UI 评审', preview: '评审 · 18 条消息', group: '今天', state: 'working' },
    { id: 's3', title: 'React 19 升级踩坑', preview: '排查中 · 7 条消息', group: '昨天', state: 'idle' },
    { id: 's4', title: '接口文档整理', preview: '10/28', group: '更早', state: 'idle' },
    { id: 's5', title: 'SQL 慢查询优化', preview: '10/25', group: '更早', state: 'idle' },
    { id: 's6', title: '多轮上下文压缩', preview: '10/21', group: '更早', state: 'idle' },
  ]

  const GROUP_ORDER = ['今天', '昨天', '更早']

  const SessionListView = {
    name: 'SessionListView',
    props: {
      /** 当前会话 id —— 跨视图共享的唯一状态（osteosome 用 sessionStorage 同步） */
      currentId: { type: String, default: 's1' },
    },
    emits: ['select', 'create'],
    setup(props, { emit }) {
      function grouped() {
        return GROUP_ORDER.map((g) => ({
          name: g,
          items: SESSIONS.filter((s) => s.group === g),
        })).filter((g) => g.items.length)
      }
      return { grouped }
    },
    render() {
      return h('div', { class: 'slv' }, [
        h('div', { class: 'slv__head' }, [
          h('span', { class: 'slv__dot' }),
          h('strong', { class: 'slv__ws' }, '工作区 · ost'),
          h('svg', { class: 'slv__chev', width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' },
            [h('path', { d: 'M9 6l6 6-6 6' })]),
        ]),

        h(UI.Button, { variant: 'primary', size: 'md', onClick: () => this.$emit('create') }, () => [
          h('span', {}, '新建会话'),
          h('span', { class: 'slv__kbd' }, '⌘N'),
        ]),

        h('div', { class: 'slv__search' }, [
          h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' },
            [h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'M20 20l-4-4' })]),
          h('span', {}, '搜索会话'),
          h('span', { class: 'slv__kbd' }, '⌘K'),
        ]),

        h('div', { class: 'slv__list' },
          this.grouped().map((g) =>
            h('div', { class: 'slv__group', key: g.name }, [
              h('div', { class: 'slv__group-name' }, g.name),
              g.items.map((s) =>
                h('button', {
                  key: s.id,
                  class: ['slv__item', { 'is-current': s.id === this.currentId }],
                  type: 'button',
                  onClick: () => this.$emit('select', s.id),
                }, [
                  h('span', { class: 'slv__item-title' }, s.title),
                  h('span', { class: 'slv__item-meta' }, [
                    h(UI.StatusDot, { state: s.state, pulse: s.state === 'thinking' || s.state === 'working' }),
                    h('span', {}, s.preview),
                  ]),
                ])
              ),
            ])
          )
        ),
      ])
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.SessionListView = SessionListView
})(window)
