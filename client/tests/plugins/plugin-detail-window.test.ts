import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import PluginDetailWindow from '../../src/plugins/PluginDetailWindow.vue'
import type { PluginListResponse } from '../../src/plugins/registry'

/**
 * S7-3：详情窗的数据改由 `/api/plugins` 提供，所以测试从「stub fetch」改成
 * **喂一份真实的 Core 响应**。这是刻意的：以前 stub 的是偏好（`{}` 就够），
 * 现在清单也走 HTTP，若还 stub 成 `{}`，「渲染不出来」和「Core 没返回」就分不清了。
 */
function coreResponse(over: Partial<PluginListResponse> = {}): PluginListResponse {
  return {
    layer: 'ok',
    pluginsDir: '/plugins',
    installOrder: ['models', 'workbench'],
    problems: [],
    cycles: [],
    plugins: [
      {
        manifest: {
          id: 'workbench',
          name: '工作台外壳',
          version: '1.0.0',
          icon: '🧭',
          description: '系统可观测性面板',
          services: [],
          components: ['widget.system-info', 'widget.settings'],
          capabilities: [{ name: 'system.info', detail: '读取版本' }],
          dependencies: [{ pluginId: 'models' }],
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
          id: 'models',
          name: '模型接入',
          version: '1.0.0',
          description: '厂商接入层',
          services: ['llm-provider-openai'],
          components: [],
        },
        installed: true,
        state: 'ready',
        reason: '',
        missingDependencies: [],
        missingOptional: [],
        unhealthyServices: [],
        readyServiceCount: 1,
        serviceStates: { 'llm-provider-openai': 'ready' },
      },
    ],
    ...over,
  }
}

function mountDetail(pluginId: string, body: PluginListResponse = coreResponse()) {
  return mount(PluginDetailWindow, {
    props: { pluginId },
    global: { plugins: [createPinia()] },
  })
}

describe('PluginDetailWindow 插件详情独立窗', () => {
  let lastBody: PluginListResponse

  beforeEach(() => {
    lastBody = coreResponse()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({ ok: true, json: async () => lastBody })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('渲染介绍 / 能力 / 组件 / 依赖 / 危险区', async () => {
    const wrapper = mountDetail('workbench')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('工作台外壳')
    expect(text).toContain('系统可观测性面板')
    expect(text).toContain('介绍')
    expect(text).toContain('能力')
    expect(text).toContain('system.info')
    expect(text).toContain('组件')
    expect(text).toContain('依赖')
    expect(text).toContain('危险区')
    expect(text).toContain('卸载插件')
  })

  it('组件标题用前端 widget 注册表解析（Core 只给 id）', async () => {
    const wrapper = mountDetail('workbench')
    await flushPromises()
    expect(wrapper.text()).toContain('系统信息')
  })

  it('每个组件有「加入窗口」按钮，数量由 Core 清单推导', async () => {
    const wrapper = mountDetail('workbench')
    await flushPromises()
    const addButtons = wrapper.findAll('button').filter((b) => b.text().includes('加入窗口'))
    // 从 stub 响应里数，不写魔数 —— 增删组件时这条断言跟着变
    expect(addButtons.length).toBe(lastBody.plugins[0]!.manifest.components.length)
    await addButtons[0]!.trigger('click')
    expect(wrapper.text()).toContain('已加入')
  })

  it('未知插件显示不存在', async () => {
    const wrapper = mountDetail('nope')
    await flushPromises()
    expect(wrapper.text()).toContain('插件不存在')
  })

  it('插件层不可用时也不崩（清单为空 -> 插件不存在，而不是白屏）', async () => {
    lastBody = coreResponse({ layer: 'missing-dir', plugins: [] })
    const wrapper = mountDetail('workbench')
    await flushPromises()
    expect(wrapper.text()).toContain('插件不存在')
  })

  it('degraded 的依赖在界面上看得出未就绪', async () => {
    lastBody = coreResponse()
    lastBody.plugins[1]!.state = 'degraded'
    const wrapper = mountDetail('workbench')
    await flushPromises()
    // 依赖 label 取自对方插件名，且状态非 ready 时不应显示成就绪
    expect(wrapper.text()).toContain('模型接入')
  })

  it('Core 拉取失败时不崩（离线保持空清单）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const wrapper = mountDetail('workbench')
    await flushPromises()
    expect(wrapper.text()).toContain('插件不存在')
  })
})