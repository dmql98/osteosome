/**
 * 共享 UI 组件库 —— 对应 osteosome 的 `sdk/ui`（`@osteosome/ui`）。
 *
 * ## 边界：纯展示
 *
 * **props 进、事件出**。这些组件不自己发请求、不读 store、不 import core-client。
 * 这条边界是它能被插件直接用的前提：一个会自己去 `/api/command` 的组件，
 * 在别人的 iframe 里跑就会产生你意料之外的副作用。
 *
 * ## 为什么要自己写一套而不是用现成库
 *
 * 组件库存在的意义不是"有 Button"，而是**"Button 在所有插件里长得一样"**。
 * 配色走 `var(--color-*)` 令牌，所以换皮肤时所有插件一起变。
 *
 * ## 注册方式
 *
 * osteosome 有两套并存的形态，这是**有意的**：
 * · 宿主用 `<UiButton>` 全局注册（模板里出现上百处，不值得为此做一次纯机械改名）
 * · 插件用具名 import（插件视图是新写的，顺手就用正确形态）
 *
 * 本 Demo 是单页应用，走**具名注册**（`app.component(...)` 显式注册），
 * 但每个组件文件仍然独立导出 —— 迁回 Vue SFC 时只需改文件后缀与 import 路径。
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h

  /* ========================================================================
   * Button —— 三个变体 × 三个尺寸
   * ===================================================================== */
  const Button = {
    name: 'UiButton',
    props: {
      variant: { type: String, default: 'primary' }, // primary | ghost | danger
      size: { type: String, default: 'md' },        // sm | md | lg
      disabled: { type: Boolean, default: false },
      loading: { type: Boolean, default: false },
      type: { type: String, default: 'button' },
    },
    emits: ['click'],
    setup(props, { emit, slots }) {
      return () =>
        h(
          'button',
          {
            class: [
              'ui-btn',
              `ui-btn--${props.variant}`,
              `ui-btn--${props.size}`,
              { 'ui-btn--loading': props.loading },
            ],
            type: props.type,
            disabled: props.disabled || props.loading,
            onClick: (e) => emit('click', e),
          },
          props.loading
            ? [h('span', { class: 'ui-btn__spinner' }), h('span', { class: 'ui-btn__label' }, slots.default?.())]
            : slots.default?.()
        )
    },
  }

  /* ========================================================================
   * IconButton —— 图标按钮，必须有 aria-label
   * ===================================================================== */
  const IconButton = {
    name: 'UiIconButton',
    props: {
      label: { type: String, required: true }, // 无障碍名，必填
      size: { type: String, default: 'md' },
      disabled: { type: Boolean, default: false },
      active: { type: Boolean, default: false },
    },
    emits: ['click'],
    setup(props, { emit, slots }) {
      return () =>
        h(
          'button',
          {
            class: ['ui-icon-btn', `ui-icon-btn--${props.size}`, { 'is-active': props.active }],
            type: 'button',
            'aria-label': props.label,
            title: props.label,
            disabled: props.disabled,
            onClick: (e) => emit('click', e),
          },
          slots.default?.()
        )
    },
  }

  /* ========================================================================
   * Badge —— 状态徽标
   * ===================================================================== */
  const Badge = {
    name: 'UiBadge',
    props: {
      tone: { type: String, default: 'neutral' }, // neutral | primary | info | success | danger
      size: { type: String, default: 'md' },
    },
    setup(props, { slots }) {
      return () =>
        h('span', { class: ['ui-badge', `ui-badge--${props.tone}`, `ui-badge--${props.size}`] }, slots.default?.())
    },
  }

  /* ========================================================================
   * StatusDot —— 运行态圆点（六种 motion 色）
   *
   * 这是「一行东西正在干什么」的唯一表达 —— 颜色 + 脉动频率。
   * 六个色必须色相互不相邻，且深浅两套各自取值。
   * ===================================================================== */
  const StatusDot = {
    name: 'UiStatusDot',
    props: {
      state: { type: String, default: 'idle' }, // idle|thinking|listening|working|speaking|success|error
      pulse: { type: Boolean, default: false },
      title: { type: String, default: '' },
    },
    setup(props) {
      return () =>
        h('span', {
          class: ['ui-dot', `ui-dot--${props.state}`, { 'is-pulse': props.pulse }],
          title: props.title || undefined,
          'aria-hidden': 'true',
        })
    },
  }

  /* ========================================================================
   * Spinner —— 加载指示
   * ===================================================================== */
  const Spinner = {
    name: 'UiSpinner',
    props: { size: { type: Number, default: 12 } },
    setup(props) {
      return () => h('span', { class: 'ui-spinner', style: { width: props.size + 'px', height: props.size + 'px' }, 'aria-hidden': 'true' })
    },
  }

  /* ========================================================================
   * EmptyState —— 空状态
   *
   * osteosome 的 `EmptyState` 是三个视图都用了的组件。
   * 这里多给了 `action` slot —— 因为空状态是最好的行动召唤位。
   * ===================================================================== */
  const EmptyState = {
    name: 'UiEmptyState',
    props: {
      icon: { type: String, default: '' },
      title: { type: String, required: true },
      description: { type: String, default: '' },
    },
    setup(props, { slots }) {
      return () =>
        h('div', { class: 'ui-empty' }, [
          props.icon ? h('div', { class: 'ui-empty__icon', 'aria-hidden': 'true' }, props.icon) : null,
          h('p', { class: 'ui-empty__title' }, props.title),
          props.description ? h('p', { class: 'ui-empty__desc' }, props.description) : null,
          slots.action ? h('div', { class: 'ui-empty__action' }, slots.action()) : null,
        ])
    },
  }

  /* ========================================================================
   * Card —— 容器，带可选 header / footer slot
   * ===================================================================== */
  const Card = {
    name: 'UiCard',
    props: {
      title: { type: String, default: '' },
      hoverable: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
      return () =>
        h('article', { class: ['ui-card', { 'ui-card--hoverable': props.hoverable }] }, [
          props.title || slots.header
            ? h('header', { class: 'ui-card__header' }, slots.header ? slots.header() : h('h3', { class: 'ui-card__title' }, props.title))
            : null,
          h('div', { class: 'ui-card__body' }, slots.default?.()),
          slots.footer ? h('footer', { class: 'ui-card__footer' }, slots.footer()) : null,
        ])
    },
  }

  /* ========================================================================
   * Tooltip —— 轻量提示
   * 用 title 属性 + 自绘浮层；此处保留组件形态便于后续升级为定位浮层。
   * ===================================================================== */
  const Tooltip = {
    name: 'UiTooltip',
    props: { text: { type: String, required: true }, placement: { type: String, default: 'top' } },
    setup(props, { slots }) {
      return () => h('span', { class: 'ui-tooltip', 'data-placement': props.placement }, [slots.default?.(), h('span', { class: 'ui-tooltip__bubble', role: 'tooltip' }, props.text)])
    },
  }

  /* ========================================================================
   * DisclosureRow —— 可折叠行（深seek 的折叠体系的最小单元）
   * ===================================================================== */
  const DisclosureRow = {
    name: 'UiDisclosureRow',
    props: {
      open: { type: Boolean, default: false },
      chevron: { type: String, default: 'right' }, // right | down
    },
    emits: ['toggle'],
    setup(props, { emit, slots }) {
      return () =>
        h('div', { class: ['ui-disclosure', { 'is-open': props.open }] }, [
          h(
            'button',
            {
              class: 'ui-disclosure__head',
              type: 'button',
              'aria-expanded': props.open ? 'true' : 'false',
              onClick: () => emit('toggle'),
            },
            [
              h('span', { class: ['ui-disclosure__chev', `ui-disclosure__chev--${props.chevron}`, { 'is-open': props.open }], 'aria-hidden': 'true' }),
              slots.default?.(),
            ]
          ),
          props.open ? h('div', { class: 'ui-disclosure__body' }, slots.body?.()) : null,
        ])
    },
  }

  global.OST = global.OST || {}
  global.OST.ui = {
    Button,
    IconButton,
    Badge,
    StatusDot,
    Spinner,
    EmptyState,
    Card,
    Tooltip,
    DisclosureRow,
  }
})(window)
