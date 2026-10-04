import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import PanelContainer from '../../src/panes/PanelContainer.vue'
import PluginWidgetHost from '../../src/widgets/PluginWidgetHost.vue'
import { usePluginStore } from '../../src/stores/plugin.store'
import type { PluginListResponse, PluginSnapshot } from '../../src/plugins/registry'

/**
 * P4：面板容器按解析结果画三种东西 —— 本地组件 / 插件 iframe / 已移除占位。
 *
 * 这轮最容易出的错是**少画一种**：省略占位的话，用户布局里存着的 id 会安静地
 * 消失一个框（症状：「我拖好的布局怎么少了一个」）。所以这里专门盯住
 * 「被移除的 id 仍然占一个可拖、可删的框，并说清为什么」。
 *
 * ## 本文件只挂「不涉及真实本地 widget」的三种情况
 *
 * 真实本地 widget 一挂上就会订阅 SSE / 发 fetch；一旦其中一次请求在用例结束后
 * 才 reject，那个未处理的 rejection 会把**后面**用例的 mount 顶掉 ——
 * 报错点落在测试框架里（`Cannot read properties of null (reading '$')`），
 * 真正的祸首在几个用例之前，几乎无法归因。
 * 所以「本地分支确实渲染了组件」这条性质改在两处验证：
 * `tests/widgets/resolve.test.ts`（形态解析：loader 必须已被包成异步组件）
 * 与 `tests/widgets/registry.test.ts`（注册表与 Core 清单的对账）。
 */
function snapshot(over: Partial<PluginSnapshot> & { id: string }): PluginSnapshot {
  return {
    manifest: {
      id: over.id,
      name: over.id,
      version: '1.0.0',
      services: [],
      components: [],
      ...(over.manifest ?? {}),
    },
    installed: true,
    state: 'ready',
    reason: '',
    missingDependencies: [],
    missingOptional: [],
    unhealthyServices: [],
    readyServiceCount: 0,
    serviceStates: {},
    ...over,
  } as PluginSnapshot
}

/** 把一份清单塞进 store（绕开 HTTP：这层只关心「拿到清单之后怎么画」） */
function applyCatalog(plugins: PluginSnapshot[]): void {
  const store = usePluginStore()
  const body: PluginListResponse = {
    layer: 'ok',
    pluginsDir: '/plugins',
    installOrder: plugins.map((p) => p.manifest.id),
    problems: [],
    cycles: [],
    plugins,
  }
  store.applyCatalog(body)
}

function mountPanel(widgets: string[]) {
  const wrapper = mount(PanelContainer, {
    props: { params: { widgets } },
    global: {
      plugins: [pinia],
      stubs: { MovableBox: false, MovableGroup: false },
    },
  })
  mounted.push(wrapper)
  return wrapper
}

/**
 * 等到异步组件真的挂上。
 *
 * 只 `flushPromises()` 不够：本地 widget 是 `defineAsyncComponent`，而 Vitest 里
 * `import()` 的模块图要等 `vi.dynamicImportSettled()` 才算完。
 * 少等这一拍的症状是「盒子在、内容是 `<!---->`」—— 看起来像渲染坏了，其实是测试没等够。
 */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled()
  await flushPromises()
}

/**
 * 卸载所有挂载过的 wrapper。
 *
 * 不是洁癖：本地 widget 挂上之后会自己订阅 SSE / 发 fetch，实例不卸载就会
 * **跨用例继续跑**，把后面用例的 wrapper 顶掉（症状是莫名其妙的
 * `Cannot read properties of null (reading '$')` —— 报错点在测试框架里，
 * 真正的祸首在三个用例之前）。这类污染极难归因，所以在这里钉死。
 */
const mounted: { unmount(): void }[] = []

let fetchMock: ReturnType<typeof vi.fn>
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mounted.length = 0
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // applyCatalog 在 mount 之前就写 store，所以 pinia 必须先激活：
  // 否则 `usePluginStore()` 会在「组件外、pinia 未激活」时抛错（🍍 的老规矩）
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

describe('PanelContainer · 三种形态', () => {

  it('插件视图渲染成 iframe，src 是 Core 的插件 UI 路由', async () => {
    applyCatalog([
      snapshot({
        id: 'models',
        manifest: {
          id: 'models',
          name: '模型接入',
          version: '1.0.0',
          services: [],
          components: [],
          ui: { views: [{ id: 'widget.llm-settings', title: '模型设置', entry: 'index.html' }] },
        },
      }),
    ])
    const wrapper = mountPanel(['widget.llm-settings'])
    await settle()
    const host = wrapper.findComponent(PluginWidgetHost)
    expect(host.exists()).toBe(true)
    expect(host.props('src')).toBe('/plugins/models/ui/index.html')
    expect(host.props('title')).toBe('模型设置')
    expect(wrapper.find('.widget-missing').exists()).toBe(false)
  })

  it('已退役的 id 画占位，而不是消失', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.llm-providers'])
    await settle()
    const text = wrapper.text()
    expect(text).toContain('模型供应商')
    expect(text).toContain('已被移除')
    // 占位还要能让人把它删掉：说明怎么删
    expect(text).toContain('×')
    expect(wrapper.findComponent(PluginWidgetHost).exists()).toBe(false)
  })

  it('陌生 id 也画占位，但说的是「未知」而不是「已移除」', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.never-heard-of-it'])
    await settle()
    expect(wrapper.text()).toContain('未知')
    expect(wrapper.text()).toContain('widget.never-heard-of-it')
  })

  it('停用插件的组件不画（沿用「停用仅隐藏」的既有语义）', async () => {
    applyCatalog([
      snapshot({
        id: 'models',
        manifest: {
          id: 'models',
          name: '模型接入',
          version: '1.0.0',
          services: [],
          components: [],
          ui: { views: [{ id: 'widget.llm-settings', title: '模型设置', entry: 'index.html' }] },
        },
      }),
    ])
    const store = usePluginStore()
    store.enabled = { models: false }
    store.revision += 1
    const wrapper = mountPanel(['widget.llm-settings'])
    await settle()
    expect(wrapper.findComponent(PluginWidgetHost).exists()).toBe(false)
    expect(wrapper.text()).toContain('空面板')
  })
})