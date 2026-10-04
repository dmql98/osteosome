import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  __registerLocalWidgetForTest,
  __resetLocalWidgetsForTest,
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
    // P6：本地组件迁走后，缺省布局改从「builtin 插件的 views」里找盒子。
    // `PluginView.builtin` 是**已装配视图**上的必填字段（manifest 没写就算 false），
    // 所以这里必须收成 `boolean` —— 放在 `...over` 之后才不会被 `undefined` 覆盖。
    builtin: over.builtin ?? false,
  }
}

function view(over: Partial<PluginUiView> = {}): PluginUiView {
  return { id: 'widget.x', title: 'X', entry: 'index.html', ...over }
}

/**
 * 每条用例都从**同一个起点**开始：glob 扫出来的真实注册表（P6 之后是空的）。
 *
 * 需要「存在一个本地组件」的用例自己注入，见 `LOCAL_ID`。
 * 不复位的话，一个用例注入的组件会留在下一个用例里 —— 而症状是
 * 「只有从上往下跑才红」，那类失败最难查。
 */
beforeEach(() => {
  __resetLocalWidgetsForTest()
})

afterEach(() => {
  __resetLocalWidgetsForTest()
})

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
    // P6 之后宿主已经没有本地组件，真实冲突不会自然出现 —— 但规则仍然必须成立，
    // 它是「搬完 UI 之后插件那份真的生效」的前提，也是将来加回本地组件时的前提。
    // 所以这里**自己造一次冲突**：同名的本地定义 + 同名的插件视图。
    __registerLocalWidgetForTest({
      id: 'widget.collision',
      title: '本地实现',
      component: async () => ({ default: {} as never }),
    })
    const resolved = resolveWidget('widget.collision', [
      plugin({ id: 'models', views: [view({ id: 'widget.collision', title: '模型设置（插件）' })] }),
    ])
    expect(resolved.kind, '插件视图必须赢，否则搬完 UI 也不会生效').toBe('iframe')
    if (resolved.kind !== 'iframe') throw new Error('unreachable')
    expect(resolved.title).toBe('模型设置（插件）')
  })

  it('**归属 ≠ 形态**：只在 components[] 里声明的 id 绝不能解析成 iframe', () => {
    // 这条是开发期真实踩过的坑：`components[]` 只声明「这个 id 归我」
    // （插件停用时要一起藏），它不声明形态。早期版本在这里把归属当形态，
    // 结果 10 个内置 widget 全变成 `/plugins/<id>/ui/` 的 404 框。
    //
    // 断言用 `not.toBe('iframe')` 而不是 `toBe('local')`：
    // 本地注册表里有没有这个 id 是另一件事（P6 之后没有），
    // 而这条坑的**唯一**判据就是「不能是 iframe」。
    const resolved = resolveWidget('widget.chat-timeline', [
      plugin({ id: 'chat-workbench', components: ['widget.chat-timeline'] }),
    ])
    expect(resolved.kind, 'components[] 是归属声明，不是形态声明').not.toBe('iframe')
  })
})

describe('resolveWidget · 本地组件', () => {
  /**
   * 这三条测的是 `resolveWidget` 的**本地分支**：解析为 local、清单为空时仍降级为 local、
   * component 是异步对象而非裸 loader。
   *
   * 样本换过两轮（先是 `widget.service-status` / `widget.system-info`，后是
   * `widget.chat-timeline`），P6 收尾后**一个都不剩了** —— 宿主注册表是空的。
   *
   * 与其把这三条删掉（那就等于放弃 P4 的三条性质），不如注入一个合成组件：
   * 本地分支的代码还在，将来加回本地组件时它必须照常工作。
   *
   * 「清单为空时降级 local」那条尤其要留着：插件清单拉不到时不该让整个工作台空掉
   * —— 这与 P6 无关，是 P4 就有的性质。
   */
  const LOCAL_ID = 'widget.test-local-fixture'

  beforeEach(() => {
    __registerLocalWidgetForTest({
      id: LOCAL_ID,
      title: '本地组件（测试注入）',
      component: () => Promise.resolve({ default: {} as never }),
    })
  })

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