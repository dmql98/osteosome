import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { MovableBox, MovableGroup, type MovableBoxRect } from 'vue-movable-box'
import PanelContainer from '../../src/panes/PanelContainer.vue'
import PluginWidgetHost from '../../src/widgets/PluginWidgetHost.vue'
import { usePluginStore } from '../../src/stores/plugin.store'
import type { PluginListResponse, PluginSnapshot } from '../../src/plugins/registry'
import type { RectUnit } from '../../src/panes/rect'

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

describe('PanelContainer：几何相对化', () => {
  /**
   * 老布局是**绝对像素**：工作台一缩放，盒子还钉在原来的像素位置上。
   * rebuild 必须把存量 rect 就地换算成百分比、把 `rectUnit` 写回 `%`，
   * 之后拖拽落盘的也都是百分比 —— 盒子才会跟着工作台按比例变。
   */
  it('存量像素布局就地迁成百分比，且只迁一次', async () => {
    applyCatalog([
      snapshot({
        id: 'models',
        manifest: {
          id: 'models',
          name: '模型接入',
          version: '1.0.0',
          services: [],
          components: [],
          ui: { views: [{ id: 'widget.llm-settings', title: '模型配置', entry: 'index.html' }] },
        },
      }),
    ])

    const params = reactive({
      params: {
        widgets: ['widget.llm-settings'],
        layout: {
          'widget.llm-settings': { left: 100, top: 50, width: 400, height: 300, zIndex: 2 },
        },
        rectUnit: 'px' as RectUnit,
      },
      api: { updateParameters: (_patch: object) => {} },
    })
    const updateParameters = vi.fn((patch: object) => {
      Object.assign(params.params, patch)
    })
    params.api.updateParameters = updateParameters

    const wrapper = mount(PanelContainer, {
      props: { params },
      global: { plugins: [pinia], stubs: { MovableBox: false, MovableGroup: false } },
    })
    mounted.push(wrapper)
    await settle()

    expect(updateParameters).toHaveBeenCalledTimes(1)
    const payload = updateParameters.mock.calls[0]?.[0] as {
      rectUnit: RectUnit
      layout: Record<string, { left: number; top: number; width: number; height: number; zIndex?: number }>
    }
    expect(payload.rectUnit).toBe('%')

    // jsdom 量不到画布（clientWidth = 0）→ 走 rect.ts 的兜底 1600×900
    const migrated = payload.layout['widget.llm-settings']
    expect(migrated.left).toBeCloseTo((100 / 1600) * 100, 3)
    expect(migrated.top).toBeCloseTo((50 / 900) * 100, 3)
    expect(migrated.width).toBeCloseTo((400 / 1600) * 100, 3)
    expect(migrated.height).toBeCloseTo((300 / 900) * 100, 3)
    expect(migrated.zIndex).toBe(2)
  })

  it('渲染侧统一按百分比交给 MovableBox（unit-type="%"）', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.never-heard-of-it'])
    await settle()
    const box = wrapper.findComponent(MovableBox)
    expect(box.exists()).toBe(true)
    expect(box.props('unitType')).toBe('%')
    // 百分比要留小数，否则 1% 取整在窄面板上一步就跳十几像素
    expect(box.props('isKeepDecimals')).toBe(true)
  })
})

describe('PanelContainer：顶栏（全屏 / 层级）', () => {
  it('层级输入框直接跳层：读数和整叠 zIndex 一起变', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a', 'widget.b'])
    await settle()
    const boxes = wrapper.findAllComponents(MovableBox)
    const rectOf = (index: number): MovableBoxRect => boxes.at(index)!.props('modelValue') as MovableBoxRect
    expect(boxes).toHaveLength(2)
    // 顶栏只在选中时出现 —— 没选中就不该露出输入框
    expect(wrapper.find('.panel-boxes__layer-input').exists()).toBe(false)

    await boxes.at(0)!.trigger('pointerdown')
    await flushPromises()
    const input = wrapper.find<HTMLInputElement>('.panel-boxes__layer-input')
    expect(input.exists()).toBe(true)
    // 通用网格给的初始层：a = 1、b = 2
    expect(input.element.value).toBe('1')

    await input.setValue('2')
    await input.trigger('change')
    await flushPromises()
    expect(rectOf(0).zIndex).toBe(2)
    expect(rectOf(1).zIndex).toBe(1)
    // 显示的是「从底往上数第几层」，不是刚才敲进去的原始字符串
    expect(wrapper.find<HTMLInputElement>('.panel-boxes__layer-input').element.value).toBe('2')

    // 越界钳到 [1, 层数]：99 与 2 同为顶层，等于没动
    await input.setValue('99')
    await input.trigger('change')
    await flushPromises()
    expect(rectOf(0).zIndex).toBe(2)
    expect(rectOf(1).zIndex).toBe(1)

    // 空值不动布局（parseInt 给 NaN 时直接返回）
    await input.setValue('')
    await input.trigger('change')
    await flushPromises()
    expect(rectOf(0).zIndex).toBe(2)
    expect(rectOf(1).zIndex).toBe(1)
  })

  it('全屏撑满所在工作台，再点一次还原到原样', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a', 'widget.b'])
    await settle()
    const boxes = wrapper.findAllComponents(MovableBox)
    const rectOf = (index: number): MovableBoxRect => boxes.at(index)!.props('modelValue') as MovableBoxRect
    const before = { ...rectOf(0) }

    await boxes.at(0)!.trigger('pointerdown')
    await flushPromises()
    await wrapper.find('.panel-boxes__fullscreen').trigger('click')
    await flushPromises()

    const full = rectOf(0)
    // 四个值都是百分比：0/0/100/100 就是画布铺满，工作台怎么缩放都满
    expect([full.left, full.top, full.width, full.height]).toEqual([0, 0, 100, 100])
    // 顺手提到最上层：被别的盒子压住的话撑满等于白撑
    expect(full.zIndex).toBe(3)
    expect(wrapper.find<HTMLInputElement>('.panel-boxes__layer-input').element.value).toBe('2')
    expect(wrapper.find('.panel-boxes__fullscreen').text()).toBe('⤡')

    await wrapper.find('.panel-boxes__fullscreen').trigger('click')
    await flushPromises()
    // 还原连 zIndex 一起还回去
    expect(rectOf(0)).toEqual(before)
    expect(wrapper.find('.panel-boxes__fullscreen').text()).toBe('⤢')
  })
})

describe('PanelContainer：选中范围', () => {
  it('点盒子内容区也能选中，点画布空白才取消', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a'])
    await settle()
    expect(wrapper.find('.panel-boxes__header').exists()).toBe(false)

    // 内容区（本地组件的 DOM 一路冒泡到盒子根）→ 选中，顶栏和层级输入框跟着出现
    await wrapper.find('.panel-boxes__body').trigger('pointerdown')
    await flushPromises()
    expect(wrapper.find('.panel-boxes__header').exists()).toBe(true)
    expect(wrapper.find('.panel-boxes__item--selected').exists()).toBe(true)

    // 点画布空白处取消选中 —— 盒子那一下必须先 `stopPropagation`，
    // 否则会先选中再被画布这一下抹掉（表现成「点了没反应」）
    await wrapper.find('.panel-boxes__canvas').trigger('pointerdown')
    await flushPromises()
    expect(wrapper.find('.panel-boxes__header').exists()).toBe(false)
  })

  it('库把选中集收窄成「按下的那个」并 emit 时，多选不被冲掉', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a', 'widget.b'])
    await settle()
    const boxes = wrapper.findAllComponents(MovableBox)

    await boxes.at(0)!.trigger('pointerdown')
    await flushPromises()
    expect(wrapper.findAll('.panel-boxes__item--selected').length).toBe(1)

    // 真浏览器里库会在 pointerdown 时 emit update:selected=["widget.b"]
    // （「按下的那个即选中集」），Ctrl+多选必须活下来 —— 模板上是 `:selected` 单向绑定，
    // 这个 emit 没有接收方。VTU 里库自己不会发（MouseEvent 没有 isPrimary），
    // 所以这里手动模拟浏览器那次 emit。
    boxes.at(1)!.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ctrlKey: true }),
    )
    await flushPromises()
    wrapper.findComponent(MovableGroup).vm.$emit('update:selected', ['widget.b'])
    await flushPromises()

    expect(wrapper.findAll('.panel-boxes__item--selected').length).toBe(2)
  })
})

describe('PanelContainer：工作台网格', () => {
  /**
   * 网格刻度（参照尺寸 1600×900，格子 20×20px）：
   * 横 80 格 = 1.25%、竖 45 格 = 2.222222%，粗线每 5 格 = 6.25% / 11.111111%（都是 100px）。
   */
  it('网格刻度以百分比注入画布，库自带的 snapToGrid 关掉', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a'])
    await settle()

    const box = wrapper.findComponent(MovableBox)
    // 库的 snapToGrid 横竖共用一个步长，吸出来是长方形格子 —— 所以吸附改在松手时自己做
    expect(box.props('snapToGrid')).toBe(false)

    const style = wrapper.find('.panel-boxes__canvas').attributes('style') ?? ''
    expect(style).toContain('--panel-grid-x: 1.25%')
    expect(style).toContain('--panel-grid-y: 2.222222%')
    expect(style).toContain('--panel-grid-major-x: 6.25%')
    expect(style).toContain('--panel-grid-major-y: 11.111111%')
  })

  it('拖动松手收进网格（拖动过程中不吸，松手这一下才收口）', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a'])
    await settle()

    const box = wrapper.findComponent(MovableBox)
    box.vm.$emit('update:modelValue', { left: 5.5, top: 3.4, width: 20.7, height: 30.9, zIndex: 1 })
    await flushPromises()
    box.vm.$emit('drag-stop')
    await flushPromises()

    const rect = box.props('modelValue') as MovableBoxRect
    expect(rect.left).toBe(5) // 5.5 ÷ 1.25 = 4.4 → 第 4 格
    expect(rect.top).toBe(4.4444) // 3.4 ÷ 2.2222 = 1.53 → 第 2 格
    expect(rect.width).toBe(21.25)
    expect(rect.height).toBe(31.1111)
  })

  it('缩放松手把四条边一起收进网格，并且落盘', async () => {
    applyCatalog([])
    const params = reactive({
      params: {
        widgets: ['widget.a'],
        layout: {
          'widget.a': { left: 11.4337, top: 7.2, width: 33.3, height: 40.1, zIndex: 1 },
        } as Record<string, MovableBoxRect>,
        rectUnit: '%' as RectUnit,
      },
      api: { updateParameters: (_patch: object) => {} },
    })
    const updateParameters = vi.fn((patch: object) => {
      Object.assign(params.params, patch)
    })
    params.api.updateParameters = updateParameters

    const wrapper = mount(PanelContainer, {
      props: { params },
      global: { plugins: [pinia], stubs: { MovableBox: false, MovableGroup: false } },
    })
    mounted.push(wrapper)
    await settle()
    expect(updateParameters).not.toHaveBeenCalled()

    const box = wrapper.findComponent(MovableBox)
    // 库的缩放**不吸网格**（它只管拖动），所以这里手工把 rect 拨到跑偏的位置再「松手」
    box.vm.$emit('update:modelValue', { left: 11.4337, top: 7.2, width: 33.3, height: 40.1, zIndex: 1 })
    await flushPromises()
    box.vm.$emit('resize-stop')
    await flushPromises()

    const rect = box.props('modelValue') as MovableBoxRect
    expect(rect.left).toBe(11.25)
    expect(rect.top).toBe(6.6667)
    expect(rect.width).toBe(33.75)
    expect(rect.height).toBe(40)
    // 收完口就落盘，否则下次打开又跑回网格外
    expect(updateParameters).toHaveBeenCalledTimes(1)
    const payload = updateParameters.mock.calls[0]?.[0] as { rectUnit: RectUnit }
    expect(payload.rectUnit).toBe('%')
  })

  it('多选整组移动：被拖的和跟着走的盒子都收进网格', async () => {
    applyCatalog([])
    const wrapper = mountPanel(['widget.a', 'widget.b'])
    await settle()

    const boxes = wrapper.findAllComponents(MovableBox)
    expect(boxes.length).toBe(2)
    // 选中两个：单击选第一个，Ctrl+点加选第二个
    // （VTU 的 trigger 改不了 MouseEvent.ctrlKey —— 它是只读 getter，只能自己造事件）
    await boxes.at(0)!.trigger('pointerdown')
    await flushPromises()
    boxes.at(1)!.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ctrlKey: true }),
    )
    await flushPromises()
    expect(wrapper.findAll('.panel-boxes__item--selected').length).toBe(2)

    boxes.at(0)!.vm.$emit('update:modelValue', { left: 8.1, top: 5.5, width: 25.5, height: 20.3, zIndex: 1 })
    boxes.at(1)!.vm.$emit('update:modelValue', { left: 40.1, top: 20.5, width: 30.2, height: 25.5, zIndex: 2 })
    await flushPromises()
    wrapper.findComponent(MovableGroup).vm.$emit('move-stop', { leaderId: 'widget.a' })
    await flushPromises()

    const first = boxes.at(0)!.props('modelValue') as MovableBoxRect
    expect(first.left).toBe(7.5)
    expect(first.top).toBe(4.4444)
    expect(first.width).toBe(25)
    expect(first.height).toBe(20)

    const second = boxes.at(1)!.props('modelValue') as MovableBoxRect
    expect(second.left).toBe(40)
    expect(second.top).toBe(20)
    expect(second.width).toBe(30)
    expect(second.height).toBe(24.4444)
  })
})
