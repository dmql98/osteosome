import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import PluginListWindow from '../../src/plugins/PluginListWindow.vue'
import type { PluginListResponse } from '../../src/plugins/registry'

/**
 * S7-3：列表内容来自 `GET /api/plugins`，所以 fetch stub 要返回**清单**，
 * 不能再返回 `{}`。返回 `{}` 的话组件会显示「没有插件」，
 * 而那与「Core 说没有插件」长得一模一样 —— 正是这类测试最该避免的假通过。
 */
function coreResponse(over: Partial<PluginListResponse> = {}): PluginListResponse {
  return {
    layer: 'ok',
    pluginsDir: '/plugins',
    installOrder: ['credentials', 'models', 'chat-workbench', 'reliability', 'workbench'],
    problems: [],
    cycles: [],
    plugins: [
      {
        manifest: {
          id: 'workbench',
          name: '工作台外壳',
          version: '1.0.0',
          icon: '🧭',
          description: '系统可观测性',
          services: [],
          components: ['widget.system-info', 'widget.settings'],
          ui: {
            views: [
              { id: 'widget.system-info', title: '系统信息', entry: 'index.html#system-info' },
              { id: 'widget.command-palette', title: '命令面板', entry: 'index.html#command-palette' },
              { id: 'widget.event-stream', title: '事件流', entry: 'index.html#event-stream' },
            ],
          },
          dependencies: [],
        },
        installed: true,
        state: 'ready',
        reason: '',
        missingDependencies: [],
        missingOptional: [],
        unhealthyServices: [],
        readyServiceCount: 0,
        serviceStates: {},
      },
      {
        manifest: {
          id: 'chat-workbench',
          name: '对话工作台',
          version: '1.0.0',
          icon: '💬',
          description: '会话 + 循环 + 路由',
          services: ['session', 'loop', 'llm'],
          // P5/P6 之后界面组件都声明在 ui.views 里，components 恒为空。
          // 卡片上的「N 组件」如果只读 components，这一个插件就会显示 0 —— 那正是线上看到的症状。
          components: [],
          ui: {
            views: [
              { id: 'widget.session-list', title: '会话列表', entry: 'index.html' },
              { id: 'widget.chat-timeline', title: '对话', entry: 'index.html' },
              { id: 'widget.chat-composer', title: '输入框', entry: 'index.html' },
            ],
          },
          dependencies: [{ pluginId: 'models' }],
        },
        installed: true,
        state: 'degraded',
        reason: '缺必需依赖: models',
        missingDependencies: ['models'],
        missingOptional: [],
        unhealthyServices: [],
        readyServiceCount: 2,
        serviceStates: { session: 'ready', loop: 'ready', llm: 'ready' },
      },
    ],
    ...over,
  }
}

let body: PluginListResponse

function mountWindow() {
  return mount(PluginListWindow, { global: { plugins: [createPinia()] } })
}

describe('PluginListWindow 插件列表独立窗', () => {
  beforeEach(() => {
    body = coreResponse()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({ ok: true, json: async () => body })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('渲染 Core 返回的清单（名称 / 版本 / 组件数）', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('已安装 (2)')
    expect(text).toContain('工作台外壳')
    expect(text).toContain('对话工作台')
    expect(text).toContain('v1.0.0')
  })

  it('组件数按 ui.views ∪ components 数（只数 components 会恒为 0）', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    const metas = wrapper.findAll('.plugin-card__meta').map((node) => node.text())
    // workbench：components 2 个 + views 3 个，system-info 两边都有 → 去重后 4
    expect(metas.some((text) => text.startsWith('4 组件'))).toBe(true)
    // chat-workbench：components 已清空，3 个全来自 views —— 这条正是「0 组件」症状的回归
    expect(metas.some((text) => text.startsWith('3 组件'))).toBe(true)
    expect(metas.some((text) => text.startsWith('0 组件'))).toBe(false)
  })

  it('Core 说 installed=false 的不计入已安装数', async () => {
    body = coreResponse()
    body.plugins[1]!.installed = false
    const wrapper = mountWindow()
    await flushPromises()
    expect(wrapper.text()).toContain('已安装 (1)')
    expect(wrapper.text()).not.toContain('对话工作台')
  })

  it('插件层不可用时给的是「层未就绪」而不是「没有插件」', async () => {
    // 这三种在界面上必须可区分：前者是故障/未启用，后者是正常状态。
    // 全部写成「还没有插件」的话，用户只会得出「没插件」，于是以为一切正常。
    body = coreResponse({ layer: 'missing-dir', pluginsDir: '/nope', plugins: [] })
    const wrapper = mountWindow()
    await flushPromises()
    let text = wrapper.text()
    expect(text).toContain('插件目录不存在')
    expect(text).toContain('/nope')
    expect(text).not.toContain('还没有插件')

    body = coreResponse({ layer: 'disabled', plugins: [] })
    await wrapper.vm.$nextTick()
    void (await wrapper.find('.plugin-refresh').trigger('click'))
    await flushPromises()
    text = wrapper.text()
    expect(text).toContain('插件层未启用')
    expect(text).not.toContain('还没有插件')

    body = coreResponse({ layer: 'empty', plugins: [] })
    void (await wrapper.find('.plugin-refresh').trigger('click'))
    await flushPromises()
    expect(wrapper.text()).toContain('插件目录里没有清单')
  })

  it('degraded 的插件在列表里看得出状态（Core 派生的，不在前端猜）', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    expect(wrapper.text()).toContain('对话工作台')
    expect(wrapper.text()).toContain('缺必需依赖: models')
  })

  it('启用/停用是动态按钮：已启用显示「禁用」，点击后变「启用」', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    const toggle = wrapper.findAll('.plugin-toggle')[0]
    expect(toggle.text()).toBe('禁用')
    expect(toggle.classes()).toContain('plugin-toggle--disable')
    await toggle.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.plugin-toggle')[0].text()).toBe('启用')
  })

  it('点击管理打开插件详情独立窗，用的是 Core 给的 plugin id', async () => {
    const popup = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const wrapper = mountWindow()
    await flushPromises()
    const manage = wrapper.findAll('button').find((button) => button.text() === '管理')
    expect(manage).toBeTruthy()
    await manage!.trigger('click')
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('#/plugin-detail/workbench'),
      expect.any(String),
      expect.any(String),
    )
  })

  it('搜索按 Core 给的名称过滤', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    const input = wrapper.find('input')
    await input.setValue('对话')
    await flushPromises()
    expect(wrapper.text()).toContain('对话工作台')
    expect(wrapper.text()).not.toContain('工作台外壳')
  })

  it('刷新重新拉清单', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const before = fetchMock.mock.calls.length
    await wrapper.find('.plugin-refresh').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('Core 拉取失败时不崩（离线显示空态）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const wrapper = mountWindow()
    await flushPromises()
    expect(wrapper.text()).toMatch(/还没有插件|未连接|未加载/)
  })
})