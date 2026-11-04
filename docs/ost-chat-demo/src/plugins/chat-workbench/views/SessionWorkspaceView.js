/**
 * SessionWorkspaceView —— 右侧检查器。
 *
 * 对应 osteosome `plugins/chat-workbench/ui/src/views/SessionWorkspaceView.vue`。
 *
 * ## 它装什么
 *
 * 四块：上下文占用、本轮统计、子代理 lineage、快捷键。
 *
 * 共同点是**都不属于对话流本身**，而是「关于这次对话的元信息」。
 * 放在右栏而不是塞进消息里，是为了让消息流保持纯叙事 ——
 * 元信息随时可查，但不打断阅读。
 *
 * ## 上下文占用环
 *
 * 14px viewBox 的圆环 + 三段分解（系统 / 工具 / 消息）。
 * 分解条比一个总数有用得多：用户真正想知道的是
 * 「是哪部分把它吃掉了」——通常是工具定义。
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h
  const UI = global.OST.ui

  const CONTEXT_BREAKDOWN = [
    { name: '系统', pct: 6, color: 'var(--color-primary)' },
    { name: '工具', pct: 8, color: 'var(--color-primary)' },
    { name: '消息', pct: 20, color: 'var(--color-info)' },
  ]

  const STATS = [
    { k: 'LLM 耗时', v: '12.4s' },
    { k: '工具耗时', v: '4.1s' },
    { k: '首 token', v: '0.8s' },
    { k: '输出速度', v: '38 tok/s' },
    { k: '缓存命中', v: '74%', tone: 'success' },
  ]

  const AGENTS = [
    { name: 'explorer', state: 'working', note: '运行中', children: [
      { name: 'schema-reader', note: '12 次调用' },
      { name: 'api-probe', note: '已完成', state: 'success' },
    ] },
  ]

  const SHORTCUTS = [
    { k: '停止生成', v: 'Esc' },
    { k: '重新生成', v: '⌘⇧R' },
    { k: '编辑上一条', v: '↑' },
    { k: '折叠工具过程', v: '⌘⇧C' },
    { k: '命令面板', v: '⌘K' },
  ]

  const FILES = [
    'src/auth/session.ts',
    'src/auth/token.ts',
    'src/gateway/capability.ts',
  ]

  const SessionWorkspaceView = {
    name: 'SessionWorkspaceView',
    setup() {
      return { CONTEXT_BREAKDOWN, STATS, AGENTS, SHORTCUTS, FILES }
    },
    render() {
      return h('div', { class: 'swv' }, [
        h('div', { class: 'swv__tabs' }, [
          h('button', { class: 'swv__tab is-on', type: 'button' }, '详情'),
          h('button', { class: 'swv__tab', type: 'button' }, '文件'),
          h('button', { class: 'swv__tab', type: 'button' }, '终端'),
        ]),

        h('div', { class: 'swv__body' }, [
          // 上下文占用
          h('section', { class: 'swv__sec' }, [
            h('div', { class: 'swv__sec-title' }, '上下文占用'),
            h('div', { class: 'swv__ctx' }, [
              h('div', { class: 'swv__ring' }, [
                h('svg', { width: 56, height: 56, viewBox: '0 0 36 36' }, [
                  h('circle', { cx: 18, cy: 18, r: 15, fill: 'none', stroke: 'var(--color-border-soft)', 'stroke-width': 4 }),
                  h('circle', { cx: 18, cy: 18, r: 15, fill: 'none', stroke: 'var(--color-primary)', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': '32 94', transform: 'rotate(-90 18 18)' }),
                  h('text', { x: 18, y: 21, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: 'var(--color-text)' }, '34%'),
                ]),
              ]),
              h('div', { class: 'swv__ctx-rows' },
                CONTEXT_BREAKDOWN.map((b) =>
                  h('div', { class: 'swv__ctx-row', key: b.name }, [
                    h('span', { class: 'swv__ctx-name' }, b.name),
                    h('span', { class: 'swv__ctx-bar' }, [
                      h('span', { style: { width: b.pct * 3 + '%', background: b.color } }),
                    ]),
                    h('span', { class: 'swv__ctx-pct' }, b.pct + '%'),
                  ])
                )
              ),
            ]),
          ]),

          // 本轮统计
          h('section', { class: 'swv__sec' }, [
            h('div', { class: 'swv__sec-title' }, '本轮统计'),
            h('div', { class: 'swv__card' },
              STATS.map((s) =>
                h('div', { class: 'swv__kv', key: s.k }, [
                  h('span', {}, s.k),
                  h('b', { class: s.tone === 'success' ? 'is-success' : '' }, s.v),
                ])
              )
            ),
          ]),

          // 子代理
          h('section', { class: 'swv__sec' }, [
            h('div', { class: 'swv__sec-title' }, '子代理'),
            h('div', { class: 'swv__card swv__agents' },
              AGENTS.map((a) =>
                h('div', { class: 'swv__agent' }, [
                  h('div', { class: 'swv__agent-row' }, [
                    h('span', { class: 'swv__sq', style: { background: 'var(--color-info)' } }),
                    h('span', { class: 'swv__agent-name' }, a.name),
                    h('span', { class: 'swv__agent-note' }, a.note),
                  ]),
                  ...a.children.map((c) =>
                    h('div', { class: 'swv__agent-row swv__agent-row--sub', key: c.name }, [
                      h('span', { class: 'swv__sq', style: { background: c.state === 'success' ? 'var(--color-text-faint)' : 'var(--color-primary)' } }),
                      h('span', { class: 'swv__agent-name is-sub' }, c.name),
                      h('span', { class: 'swv__agent-note' }, c.note),
                    ])
                  ),
                ])
              )
            ),
          ]),

          // 引用文件
          h('section', { class: 'swv__sec' }, [
            h('div', { class: 'swv__sec-title' }, '引用文件'),
            h('div', {},
              FILES.map((f) => h('div', { class: 'swv__file', key: f }, f))
            ),
          ]),

          // 快捷键
          h('section', { class: 'swv__sec' }, [
            h('div', { class: 'swv__sec-title' }, '快捷键'),
            h('div', { class: 'swv__card' },
              SHORTCUTS.map((s) =>
                h('div', { class: 'swv__kbdrow', key: s.k }, [
                  h('span', {}, s.k),
                  h('kbd', {}, s.v),
                ])
              )
            ),
          ]),
        ]),
      ])
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.SessionWorkspaceView = SessionWorkspaceView
})(window)
