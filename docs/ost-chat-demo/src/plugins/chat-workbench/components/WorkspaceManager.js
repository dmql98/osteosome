/**
 * WorkspaceManager —— 工作区管理。
 *
 * 对应 osteosome `plugins/chat-workbench/ui/src/views/SessionWorkspaceView.vue`
 * 的工作区部分（P7 M0 WS-0.6）与 `plugins/tools/services/workspace`。
 *
 * ## 它管三件事
 *
 * 1. **项目目录** —— 会话的项目根，只读展示 + 「打开」（用系统文件管理器）
 * 2. **授权根** —— 越界授权批准后加入的目录，可移除
 * 3. **目录选择器** —— 走 `workspace.list` 浏览目录树
 *
 * ## 关键约束：workspace 服务**只列目录不读文件**
 *
 * 这是**能力边界**，不是实现细节。它只 `readdirSync` + `statSync`，
 * 从不 `readFile` —— 越界读文件的能力，模型与界面都不该经由这个服务拿到。
 * 所以界面上也只有「选目录」，没有「预览文件内容」。
 *
 * ## 沙箱 = 项目目录 ∪ 授权根
 *
 * 模型只能读写这些目录里的文件。未绑定项目时任何路径都越界，
 * 第一次调用会弹一次工作区授权（`kind:'workspace'` 的审批）。
 *
 * ## 组件边界
 *
 * props：`workspace`（项目目录）/ `roots`（授权根）/ `entries` / `dirRoots` / `picking`
 * 事件：`list` / `open` / `choose` / `remove-root` / `toggle-picker`
 *
 * 组件自己不调服务 —— 它把意图抛给宿主，宿主转成命令。
 * 这样组件能被单测，也能被宿主换掉实现（比如桌面端换成原生 dialog）。
 */
;(function (global) {
  'use strict'

  const h = global.Vue.h
  const ref = global.Vue.ref
  const computed = global.Vue.computed
  const UI = global.OST.ui

  const WorkspaceManager = {
    name: 'ChatWorkspaceManager',
    props: {
      /** 项目目录（会话级）。空串 = 未绑定 */
      workspace: { type: String, default: '' },
      /** 授权根（越界授权后加入） */
      roots: { type: Array, default: () => [] },
      /** 当前目录下的条目 */
      entries: { type: Array, default: () => [] },
      /** 盘符 / 快捷入口 */
      dirRoots: { type: Array, default: () => [] },
      /** 当前浏览路径 */
      currentPath: { type: String, default: '' },
      /** 上一级路径（null = 已在根） */
      parentPath: { type: String, default: '' },
      /** 选择器是否展开 */
      picking: { type: Boolean, default: false },
    },
    emits: ['list', 'open', 'choose', 'remove-root', 'toggle-picker'],
    setup(props, { emit }) {
      const isBound = computed(() => !!props.workspace)

      /** 目录 → 进入；文件 → 无动作（workspace 服务不读文件） */
      function onEntry(e) {
        if (e.isDir) emit('list', e.path)
      }

      /** 双击目录 → 选为项目 */
      function onEntryDbl(e) {
        if (e.isDir) emit('choose', e.path)
      }

      function entryIcon(e) {
        return e.isDir ? '📁' : '📄'
      }

      function rootIcon(r) {
        return r.kind === 'drive' ? '💽' : '⭐'
      }

      return { isBound, onEntry, onEntryDbl, entryIcon, rootIcon }
    },
    render() {
      const s = this

      return h('div', { class: 'wsm' }, [
        // ── 项目目录 ─────────────────────────────
        h('section', { class: 'wsm__row' }, [
          h('div', { class: 'wsm__col' }, [
            h('div', { class: 'wsm__label' }, '项目目录'),
            h('div', { class: 'wsm__value' }, [
              h('code', { 'data-testid': 'ws-project' }, this.workspace || '（未绑定项目）'),
            ]),
          ]),
          h(UI.Button, {
            variant: 'ghost', size: 'sm',
            disabled: !this.isBound,
            onClick: () => s.$emit('open', s.workspace),
          }, () => '打开'),
          h(UI.Button, {
            variant: 'primary', size: 'sm',
            onClick: () => s.$emit('toggle-picker'),
          }, () => (this.picking ? '取消' : '选择项目')),
        ]),

        // ── 目录选择器 ───────────────────────────
        this.picking
          ? h('section', { class: 'wsm__picker', 'data-testid': 'ws-picker' }, [
              // 面包屑
              h('div', { class: 'wsm__crumbs' }, [
                h('button', {
                  class: 'wsm__crumb', type: 'button',
                  onClick: () => s.$emit('list', ''),
                }, '根'),
                this.currentPath
                  ? h('button', {
                      class: 'wsm__crumb', type: 'button',
                      onClick: () => s.$emit('list', s.parentPath || ''),
                    }, '..')
                  : null,
                h('span', { class: 'wsm__path mono' }, this.currentPath || '（盘符 / 快捷入口）'),
              ]),

              // 条目网格：目录在前
              h('div', { class: 'wsm__grid' }, [
                ...this.entries.map((e) =>
                  h('button', {
                    key: e.path,
                    type: 'button',
                    class: ['wsm__entry', { 'is-dir': e.isDir }],
                    title: e.path,
                    onClick: () => s.onEntry(e),
                    onDblclick: () => s.onEntryDbl(e),
                  }, [
                    h('span', { class: 'wsm__entry-ico', 'aria-hidden': 'true' }, s.entryIcon(e)),
                    h('span', { class: 'wsm__entry-name' }, e.name),
                  ])
                ),
                // 盘符与快捷入口
                ...this.dirRoots.map((r) =>
                  h('button', {
                    key: r.path,
                    type: 'button',
                    class: 'wsm__entry is-dir',
                    title: r.path,
                    onClick: () => s.$emit('list', r.path),
                  }, [
                    h('span', { class: 'wsm__entry-ico', 'aria-hidden': 'true' }, s.rootIcon(r)),
                    h('span', { class: 'wsm__entry-name' }, r.name),
                  ])
                ),
              ]),

              h('div', { class: 'wsm__picker-actions' }, [
                h('span', { class: 'wsm__hint' }, '点目录进入，双击选为项目'),
                h('span', { class: 'wsm__sp' }),
                this.currentPath
                  ? h(UI.Button, { variant: 'primary', size: 'sm', onClick: () => s.$emit('choose', s.currentPath) }, () => '选这个目录')
                  : null,
              ]),
            ])
          : null,

        // ── 授权根 ───────────────────────────────
        this.roots.length
          ? h('section', { class: 'wsm__row' }, [
              h('div', { class: 'wsm__col' }, [
                h('div', { class: 'wsm__label' }, '授权根（越界授权后加入）'),
                h('ul', { class: 'wsm__roots' },
                  this.roots.map((w) =>
                    h('li', { class: 'wsm__root', key: w }, [
                      h('code', {}, w),
                      h('button', {
                        class: 'wsm__x', type: 'button',
                        title: '移除',
                        'aria-label': '移除授权根 ' + w,
                        onClick: () => s.$emit('remove-root', w),
                      }, '×'),
                    ])
                  )
                ),
              ]),
            ])
          : null,

        // ── 说明 ─────────────────────────────────
        h('p', { class: 'wsm__note' },
          '沙箱 = 项目目录 ∪ 授权根；模型只能读写这些目录里的文件。' +
          '未绑定项目时任何路径都越界，第一次调用会弹一次工作区授权。'),
      ])
    },
  }

  global.OST = global.OST || {}
  global.OST.components = global.OST.components || {}
  global.OST.components.WorkspaceManager = WorkspaceManager
})(window)
