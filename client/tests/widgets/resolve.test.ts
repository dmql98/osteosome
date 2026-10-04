import { describe, expect, it } from 'vitest'
import {
  addableWidgetIds,
  resolveWidget,
  RETIRED_WIDGETS,
} from '../../src/widgets/registry'
import { pluginViewSrc } from '../../src/widgets/types'
import type { PluginUiView, PluginView } from '../../src/plugins/registry'

/**
 * P4：widget id → 「它到底是什么」的解析。
 *
 * 这层是新老两套形态的**唯一交界处**，所以用例盯的不是「某个 id 能不能解析」，
 * 而是**优先级与三种结局**：本地组件 / 插件 iframe / 占位。
 * 其中「归属 ≠ 形态」那条是本轮最容易写错的地方，单独有回归。
 */

function plugin(over: Partial<PluginView> = {}): PluginView {
  return {
    id: 'p',
    name: 'p',
    icon: 'p',
    version: '1.0.0',
    description: '',
    capabilities: [],
    components: [],
    views: [],
    services: [],
    dependencies: [],
    state: 'ready',
    reason: '',
    installed: true,
    missingDependencies: [],
    missingOptional: [],
    unhealthyServices: [],
    readyServiceCount: 0,
    totalServices: 0,
    serviceStates: {},
    ...over,
  }
}

function view(over: Partial<PluginUiView> = {}): PluginUiView {
  return { id: 'widget.x', title: 'X', entry: 'index.html', ...over }
}

describe('resolveWidget · 插件视图 → iframe', () => {
  it('声明了 ui.views 的 id 解析成 iframe，src 指向 Core 的插件 UI 路由', () => {
    const resolved = resolveWidget('widget.llm-settings', [
      plugin({
        id: 'models',
        views: [view({ id: 'widget.llm-settings', title: '模型设置', entry: 'index.html' })],
      }),
    ])
    expect(resolved.kind).toBe('iframe')
    if (resolved.kind !== 'iframe') throw new Error('unreachable')
    expect(resolved.title).toBe('模型设置')
    expect(resolved.pluginId).toBe('models')
    expect(resolved.src).toBe('/plugins/models/ui/index.html')
  })

  it('hash 入口留在 src 里（视图之间用 hash 切，不产生服务端请求）', () => {
    const resolved = resolveWidget('widget.timeline', [
      plugin({ id: 'chat-workbench', views: [view({ id: 'widget.timeline', entry: 'index.html#timeline' })] }),
    ])
    expect(resolved.kind === 'iframe' && resolved.src).toBe('/plugins/chat-workbench/ui/index.html#timeline')
  })

  it('pluginId 走 encodeURIComponent：目录名带空格/斜杠也不会拼出越界的 URL', () => {
    expect(pluginViewSrc('a b/c', 'index.html')).toBe('/plugins/a%20b%2Fc/ui/index.html')
  })

  it('插件视图优先于同 id 的本地组件（迁移方向不能反）', () => {
    // `widget.llm-settings` 现在**确实**存在本地组件（client/src/widgets/llm-settings）。
    // 插件一旦声明同名视图就必须接管，否则搬完 UI 也不会生效 ——
    // 而这种错会静默到有人去翻产物目录才发现。
    const resolved = resolveWidget('widget.llm-settings', [
      plugin({ id: 'models', views: [view({ id: 'widget.llm-settings', title: '模型设置（插件）' })] }),
    ])
    expect(resolved.kind).toBe('iframe')
  })

  it('**归属 ≠ 形态**：只在 components[] 里声明的本地组件仍是 local，不是 iframe', () => {
    // 这条是开发期真实踩过的坑：`components[]` 只声明「这个 id 归我」
    // （插件停用时要一起藏），它不声明形态。早期版本在这里把归属当形态，
    // 结果 10 个内置 widget 全变成 `/plugins/<id>/ui/` 的 404 框。
    const resolved = resolveWidget('widget.chat-timeline', [
      plugin({ id: 'chat-workbench', components: ['widget.chat-timeline'] }),
    ])
    expect(resolved.kind).toBe('local')
  })
})

describe('resolveWidget · 本地组件', () => {
  /**
   * P6 之后用来验证「本地组件」这条路径的样本换成了仍在宿主的 widget。
   *
   * 原来这三条用的是 `widget.service-status` / `widget.system-info`，
   * 随设置等六个组件一起搬进了 workbench 插件。
   *
   * 三条断言**测的东西一点没变**（解析为 local、清单为空时仍降级为 local、
   * component 是异步对象而非裸 loader），只是样本换了。降级那条尤其要留着：
   * 插件清单拉不到时不该让整个工作台空掉 —— 这与 P6 无关，是 P4 就有的性质。
   */
  const LOCAL_ID = 'widget.chat-timeline'

  it('没有插件声明时解析为本地组件', () => {
    expect(resolveWidget(LOCAL_ID).kind).toBe('local')
    expect(resolveWidget(LOCAL_ID).title).toBeTruthy()
  })

  it('插件清单为空（Core 还没返回 / 离线）也照常解析本地组件', () => {
    expect(resolveWidget(LOCAL_ID, []).kind).toBe('local')
  })

  it('component 已经是**异步组件对象**，不是裸 loader', () => {
    // 这条守住一个静默 bug：definition 里存的是 `() => import(...)`，
    // 直接把它交给模板 `:is`，Vue 会当成函数式组件调用、拿到 Promise 当渲染结果 ——
    // 盒子照画、里面永远是空的，**没有任何报错**。
    const resolved = resolveWidget(LOCAL_ID)
    if (resolved.kind !== 'local') throw new Error('unreachable')
    // `defineAsyncComponent()` 返回对象；裸 loader 是函数
    expect(typeof resolved.component).not.toBe('function')
    expect(typeof resolved.component).toBe('object')
  })

  it('搬进 workbench 插件的六个组件在无插件清单时解析为 missing（不再是本地组件）', () => {
    // P6 的行为变更：Core 没返回插件清单时，这些组件**不会**退回本地实现，
    // 而是走 missing 占位。原因很直接 —— 本地那份已经不存在了，
    // 而「静默画一个空盒子」比「明确显示找不到」更难排查。
    // 对应的正路是 Core 的插件清单返回后走 iframe。
    for (const id of ['widget.service-status', 'widget.system-info', 'widget.settings']) {
      expect(resolveWidget(id, []).kind, id).toBe('missing')
    }
  })
})

describe('resolveWidget · 占位（曾经存在，现在不在了）', () => {
  it('已退役的 id：说得出它叫什么、为什么没了', () => {
    const resolved = resolveWidget('widget.llm-providers')
    expect(resolved.kind).toBe('missing')
    if (resolved.kind !== 'missing') throw new Error('unreachable')
    expect(resolved.title).toBe(RETIRED_WIDGETS['widget.llm-providers']!.title)
    expect(resolved.reason).toBe('removed')
  })

  it('退役表给了接替者（占位上要能告诉用户换成哪个）', () => {
    expect(RETIRED_WIDGETS['widget.llm-providers']?.replacedBy).toBe('widget.llm-settings')
  })

  it('完全陌生的 id：也是占位，但说「未知」而不是「已移除」', () => {
    const resolved = resolveWidget('widget.never-existed')
    expect(resolved.kind === 'missing' && resolved.reason).toBe('unknown')
    expect(resolved.title).toBe('widget.never-existed')
  })

  it('停用的插件不算 missing：id 仍解析得出来，由渲染层决定隐藏', () => {
    // 沿用既有语义「停用仅隐藏，重新启用自动恢复」——
    // 若这里返回 missing，用户停用一个插件再启用，组件就变成占位且**再也回不来**。
    const resolved = resolveWidget('widget.x', [plugin({ id: 'p', views: [view()] })])
    expect(resolved.kind).toBe('iframe')
  })
})

describe('addableWidgetIds', () => {
  it('插件视图 + 本地组件归属，去重后一起给出去', () => {
    const ids = addableWidgetIds(
      plugin({
        id: 'chat-workbench',
        views: [view({ id: 'widget.session-list', title: '会话' })],
        components: ['widget.chat-timeline', 'widget.session-list'],
      }),
    )
    expect(new Set(ids)).toEqual(new Set(['widget.session-list', 'widget.chat-timeline']))
  })

  it('纯服务插件（既无 views 也无 components）返回空数组，不返回 undefined', () => {
    expect(addableWidgetIds(plugin({ id: 'credentials' }))).toEqual([])
  })
})