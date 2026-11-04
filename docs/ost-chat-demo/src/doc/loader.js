/**
 * 组件陈列页的公共装载器。
 *
 * 每个组件一个 HTML 都引它 —— 负责：
 * · 加载 Vue 运行时与组件实现
 * · 提供主题切换（明/暗）
 * · 提供「上一件 / 下一件 / 索引」导航
 *
 * 用法：
 *   <script src="../src/doc/loader.js"></script>
 *   <script>
 *     OST.doc.mount({
 *       title: '对话框',
 *       desc: '……',
 *       file: 'src/plugins/chat-workbench/components/MessageBubble.js',
 *       scripts: [
 *         '../src/ui/index.js',
 *         '../src/plugins/chat-workbench/components/ThinkingBlock.js',
 *         '../src/plugins/chat-workbench/components/MessageBubble.js',
 *       ],
 *       render: function (h) { return h(OST.components.MessageBubble, {...}) },
 *     })
 *   </script>
 */
;(function (global) {
  'use strict'

  /**
   * 组件清单 —— 索引页与导航共用。
   *
   * 只有 6 个顶层组件。注意「对话流」一个组件里包含了思考块、对话框、
   * Turn 导航轨、工具调用树、统计栏 —— 它们是对话流的内部构造，
   * 不是平级的顶层组件。
   */
  const CATALOG = [
    { file: 'timeline.html', name: '对话流', desc: '对话区主组件。左导航轨 + 右消息区，内含思考块 / 工具调用树 / 对话框 / 统计栏。', src: 'src/plugins/chat-workbench/components/ChatTimeline.js' },
    { file: 'sessionlist.html', name: '对话列表', desc: '会话树。状态点表示这一轮在干什么。', src: 'src/plugins/chat-workbench/views/SessionListView.js' },
    { file: 'composer.html', name: '输入框', desc: '常驻输入区。Enter 发送 / Esc 停止 / ↑ 调出上一条。', src: 'src/plugins/chat-workbench/views/ChatComposerView.js' },
    { file: 'workspace.html', name: '检查器', desc: '上下文占用 / 本轮统计 / 子代理 lineage / 快捷键。', src: 'src/plugins/chat-workbench/views/SessionWorkspaceView.js' },
    { file: 'workspace-manager.html', name: '工作区管理', desc: '项目目录 + 授权根 + 目录选择器。沙箱 = 项目目录 ∪ 授权根。', src: 'src/plugins/chat-workbench/components/WorkspaceManager.js' },
    { file: 'approval.html', name: '审批块', desc: '独立浮出的授权面板。由工具调用触发，补齐了「始终允许」的作用域说明。', src: 'src/plugins/chat-workbench/components/ApprovalPanel.js' },
  ]

  /** 动态加载脚本（按顺序） */
  function loadScripts(urls, done) {
    let i = 0
    ;(function next() {
      if (i >= urls.length) return done()
      const s = document.createElement('script')
      s.src = urls[i++]
      s.onload = next
      s.onerror = () => {
        const pre = document.createElement('pre')
        pre.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#fdecee;color:#cf222e;padding:10px;font:12px monospace;white-space:pre-wrap'
        pre.textContent = '脚本加载失败：' + urls[i - 1]
        document.body.appendChild(pre)
      }
      document.head.appendChild(s)
    })()
  }

  const doc = {
    CATALOG,

    /**
     * 装配一个组件陈列页。
     * @param {{title:string,desc:string,file:string,scripts:string[],render:Function,points?:Array,contract?:Array,code?:string}} opt
     */
    mount(opt) {
      const Vue = global.Vue
      const h = Vue.h

      // 主题：跟随系统 + 可手动切
      const stored = localStorage.getItem('ost-doc-theme')
      if (stored) document.documentElement.setAttribute('data-theme', stored)
      else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark')
      }

      loadScripts(opt.scripts, () => {
        const idx = CATALOG.findIndex((c) => c.file === currentFile())
        const prev = idx > 0 ? CATALOG[idx - 1] : null
        const next = idx >= 0 && idx < CATALOG.length - 1 ? CATALOG[idx + 1] : null

        const App = {
          setup() {
            const theme = Vue.ref(document.documentElement.getAttribute('data-theme') || 'light')
            function toggleTheme() {
              const nextTheme = theme.value === 'dark' ? 'light' : 'dark'
              theme.value = nextTheme
              document.documentElement.setAttribute('data-theme', nextTheme)
              localStorage.setItem('ost-doc-theme', nextTheme)
            }
            return { theme, toggleTheme }
          },
          render() {
            const stage = h('div', { class: 'stage stage--inset stage--reveal' }, opt.render(h))
            return h('div', { class: 'doc' }, [
              // 导航
              h('nav', { class: 'doc-nav' }, [
                h('a', { href: 'index.html' }, '← 组件索引'),
                prev ? h('a', { href: prev.file }, '上一件 · ' + prev.name) : null,
                next ? h('a', { href: next.file }, '下一件 · ' + next.name) : null,
                h('span', { class: 'doc-nav__count' }, (idx + 1) + ' / ' + CATALOG.length),
                h('button', {
                  class: 'ui-btn ui-btn--ghost ui-btn--sm',
                  onClick: () => this.toggleTheme(),
                }, this.theme === 'dark' ? '浅色' : '深色'),
              ]),

              // 头部
              h('header', { class: 'doc__head' }, [
                h('div', { class: 'doc__id' }, String(idx + 1)),
                h('div', {}, [
                  h('h1', { class: 'doc__title' }, opt.title),
                  h('div', { class: 'doc__path' }, opt.file),
                  h('p', { class: 'doc__desc', innerHTML: opt.desc }),
                ]),
              ]),

              // 示例
              h('section', { class: 'doc__sec' }, [
                h('div', { class: 'doc__sec-title' }, '示例'),
                stage,
              ]),

              // 契约
              opt.contract && opt.contract.length
                ? h('section', { class: 'doc__sec' }, [
                    h('div', { class: 'doc__sec-title' }, '接口契约'),
                    h('table', { class: 'contract' }, [
                      h('thead', {}, h('tr', {}, [
                        h('th', {}, '名称'), h('th', {}, '类型'), h('th', {}, '默认值'), h('th', {}, '说明'),
                      ])),
                      h('tbody', {}, opt.contract.map((r) =>
                        h('tr', {}, [
                          h('td', { class: 'c-name' }, r[0]),
                          h('td', { class: 'c-type' }, r[1]),
                          h('td', {}, r[2]),
                          h('td', {}, r[3]),
                        ])
                      )),
                    ]),
                  ])
                : null,

              // 要点
              opt.points && opt.points.length
                ? h('section', { class: 'doc__sec' }, [
                    h('div', { class: 'doc__sec-title' }, '设计要点'),
                    h('ul', { class: 'points' }, opt.points.map((p) => h('li', { innerHTML: p }))),
                  ])
                : null,

              // 代码
              opt.code
                ? h('section', { class: 'doc__sec' }, [
                    h('div', { class: 'doc__sec-title' }, '用法'),
                    h('pre', { class: 'code' }, opt.code),
                  ])
                : null,
            ])
          },
        }

        Vue.createApp(App).mount('#app')
      })
    },
  }

  function currentFile() {
    const f = location.pathname.split('/').pop()
    return f || 'index.html'
  }

  global.OST = global.OST || {}
  global.OST.doc = doc
})(window)
