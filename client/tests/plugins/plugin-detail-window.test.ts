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
          dependencies: [{ pluginId: 'credentials' }, { pluginId: 'telemetry', optional: true }],
        },
        installed: true,
        state: 'degraded',
        reason: '缺必需依赖: credentials',
        missingDependencies: ['credentials'],
        missingOptional: ['telemetry'],
        unhealthyServices: ['llm-provider-openai'],
        readyServiceCount: 0,
        serviceStates: { 'llm-provider-openai': 'failed' },
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
    expect(wrapper.text()).not.toContain('已就绪')
  })

  it('S7-6：degraded 的插件显示状态明细（原因 / 缺必需依赖 / 未就绪服务 / 缺可选依赖）', async () => {
    const wrapper = mountDetail('models')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('状态明细')
    expect(text).toContain('缺必需依赖: credentials')
    expect(text).toContain('缺必需依赖')
    expect(text).toContain('credentials')
    expect(text).toContain('未就绪的服务')
    expect(text).toContain('llm-provider-openai')
    // 可选依赖也要说，但要说清它不影响状态
    expect(text).toContain('缺可选依赖')
    expect(text).toContain('telemetry')
  })

  it('S7-6：服务清单逐个显示状态与「N / M 就绪」', async () => {
    const wrapper = mountDetail('models')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('0 / 1 就绪')
    expect(text).toContain('llm-provider-openai')
    expect(text).toContain('故障')
  })

  it('S7-6：一切正常时不展开状态明细（不占地方）', async () => {
    const wrapper = mountDetail('workbench')
    await flushPromises()
    expect(wrapper.text()).not.toContain('状态明细')
    // 无服务的插件要说清是「不带服务」，而不是空白
    expect(wrapper.text()).toContain('该插件不带服务')
  })

  it('S7-6：hero 状态反映 Core 的判定，不只看用户意愿', async () => {
    // 与列表窗 S7-3 修的是同一个缺口，两处必须一致，
    // 否则「列表说降级、详情说运行中」比只说错更糟
    const wrapper = mountDetail('models')
    await flushPromises()
    expect(wrapper.text()).toContain('降级')
    expect(wrapper.text()).not.toContain('运行中')
  })

  it('S7-6：服务未在跑时区分「未在跑」与「随插件停用」', async () => {
    // 同一个「进程没在跑」，在两种情况下含义完全不同：
    // · 插件启用着 -> 「未在跑」= 有点问题，去看看
    // · 插件被用户停了 -> 「随插件停用」= 你的决定，不是故障
    lastBody = coreResponse()
    lastBody.plugins[1]!.state = 'stopped'
    lastBody.plugins[1]!.serviceStates = {}
    const running = mountDetail('models')
    await flushPromises()
    expect(running.text()).toContain('未在跑')
    expect(running.text()).not.toContain('随插件停用')

    // 偏好里把 models 停用 —— 走真实响应，不直接改 store，
    // 因为「独立窗口要自己拉偏好」正是这条要守的东西
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/preferences')) {
          return { ok: true, json: async () => ({ plugins: { enabled: { models: false } } }) }
        }
        return { ok: true, status: 202, json: async () => lastBody }
      }),
    )
    const disabled = mountDetail('models')
    await flushPromises()
    expect(disabled.text()).toContain('随插件停用')
    expect(disabled.text()).toContain('已停用')
  })

  it('独立窗口自己拉偏好，不依赖主窗口已经拉过', async () => {
    // 插件列表窗 / 详情窗各有各的 pinia，主窗口的 bootstrap() 对它们无效。
    // 若哪天有人把 usePlugins 里那行 bootstrap 删了，症状是
    // 「已停用的插件显示成启用中」且**没有任何报错** —— 所以钉住它。
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        requested.push(url)
        if (url.includes('/api/preferences')) {
          return { ok: true, json: async () => ({ plugins: { enabled: { models: false } } }) }
        }
        return { ok: true, json: async () => lastBody }
      }),
    )
    const wrapper = mountDetail('workbench')
    await flushPromises()
    expect(requested.some((u) => u.includes('/api/preferences'))).toBe(true)
    expect(wrapper.text()).toContain('依赖')
  })

  it('Core 拉取失败时不崩（离线保持空清单）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const wrapper = mountDetail('workbench')
    await flushPromises()
    expect(wrapper.text()).toContain('插件不存在')
  })
})