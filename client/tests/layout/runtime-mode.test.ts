/**
 * 运行模式的三条约定（用户反馈驱动）。
 *
 * 运行模式是**默认且正常使用**的模式，不是「编辑模式的反面」。
 * 之前它顺手做了三件多余的事，于是界面变得像坏了：
 *
 * 1. 面板顶栏被藏起来（还要悬停才浮现）→ 用户以为面板不见了
 * 2. 每个组件盒子被标 `is-disabled` → **到处都是禁止光标**，且组件被淡化到 60%
 * 3. 连带 `user-select: none` → 对话记录里的报错、模型名都复制不了
 *
 * 这里把它们钉住。**这些都不是「运行时该有的样子」，是实现顺手带出来的副作用。**
 */
import { describe, expect, it } from 'vitest'
import { applyModeToGroup } from '../../src/layout/mode'

/** 造一个只含本函数用到的字段的假 group —— 不引入 dockview 全套依赖 */
function fakeGroup() {
  const state = { locked: false as unknown, headerHidden: false }
  const group = {
    get locked() {
      return state.locked
    },
    set locked(v: unknown) {
      state.locked = v
    },
    model: {
      header: {
        get hidden() {
          return state.headerHidden
        },
        set hidden(v: boolean) {
          state.headerHidden = v
        },
      },
    },
  }
  return { group, state }
}

describe('运行模式 · 面板顶栏不再被隐藏', () => {
  it('切到运行模式时 header.hidden 保持 false', () => {
    const { group, state } = fakeGroup()
    applyModeToGroup(group as never, 'runtime')
    expect(state.headerHidden).toBe(false)
  })

  it('切到编辑模式时也不动 header.hidden', () => {
    const { group, state } = fakeGroup()
    state.headerHidden = true
    applyModeToGroup(group as never, 'edit')
    // 编辑模式也不该由这里去改 header —— 隐藏不是这两个模式该管的事
    expect(state.headerHidden).toBe(true)
  })

  it('locked 仍然生效 —— 那才是运行模式真正要防的（别把面板拖乱）', () => {
    const run = fakeGroup()
    applyModeToGroup(run.group as never, 'runtime')
    expect(run.state.locked).toBe('no-drop-target')

    const edit = fakeGroup()
    applyModeToGroup(edit.group as never, 'edit')
    expect(edit.state.locked).toBe(false)
  })

  it('模式来回切不会把 locked 留在脏状态', () => {
    const { group, state } = fakeGroup()
    applyModeToGroup(group as never, 'runtime')
    applyModeToGroup(group as never, 'edit')
    applyModeToGroup(group as never, 'runtime')
    expect(state.locked).toBe('no-drop-target')
    expect(state.headerHidden).toBe(false)
  })
})

describe('运行模式 · 禁止光标来自 MovableBox 的 is-disabled', () => {
  /**
   * 这条测试的作用是**把根因钉住**，而不是测我们的 CSS。
   *
   * 库 CSS：`node_modules/vue-movable-box/lib/css/VueMovableBox.css`
   *   `.auto-draggable.is-disabled { cursor: not-allowed !important; opacity: .6 }`
   *   `.auto-draggable { user-select: none }`
   *
   * 而盒子铺满整个面板 → 运行模式下**全屏**都是禁止光标。
   * 我们的修法是在 PanelContainer 里覆盖这三个副作用（且保留 `disabled` 以隐藏手柄）。
   *
   * 如果哪天升级 vue-movable-box 改了类名，这条会失败并提醒重新查一遍。
   */
  const LIB_CSS = 'node_modules/vue-movable-box/lib/css/VueMovableBox.css'

  it('库确实会加 is-disabled → 我们的覆盖是必需的，不是多余的', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const path = await import('node:path')
    const file = path.join(process.cwd(), '..', LIB_CSS)
    if (!existsSync(file)) {
      // 依赖布局变了就跳过，但要在输出里留下痕迹而不是静默通过
      console.warn('[runtime-mode] 找不到 ' + LIB_CSS + '，跳过根因断言')
      return
    }
    const css = readFileSync(file, 'utf8')
    expect(css).toContain('.auto-draggable.is-disabled')
    expect(css).toContain('cursor:not-allowed')
    expect(css).toContain('opacity:.6')
    expect(css).toContain('user-select:none')
  })
})