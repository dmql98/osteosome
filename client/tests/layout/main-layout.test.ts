import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import MainLayout from '../../src/layouts/MainLayout.vue'
import { usePluginStore } from '../../src/stores/plugin.store'
import type { PluginListResponse } from '../../src/plugins/registry'

/**
 * 主窗必须自己拉插件清单。
 *
 * 这是一条**回归**测试：`usePlugins()`（唯一会调 `applyCatalog` 的地方）曾只在
 * 插件列表窗 / 详情窗里被调用，主窗只 `bootstrap()` 偏好。P5/P6 把宿主 widget
 * 注册表清空之后，主窗 `views` 恒为空 —— 结果是 `addWidget` 在
 * `kind === 'missing'` 处静默 return（详情窗点「加入窗口」毫无反应）、
 * 盒子画成「未知组件」、默认布局是空面板。三个症状一个根因。
 */
vi.mock('../../src/core-sdk/usePreferences', () => ({
  usePreferences: vi.fn(() => ({ get: vi.fn().mockResolvedValue({ layout: '' }), patch: vi.fn() })),
}))

function catalog(): PluginListResponse {
  return {
    layer: 'ok',
    pluginsDir: '/plugins',
    installOrder: ['chat-workbench'],
    problems: [],
    cycles: [],
    plugins: [
      {
        manifest: {
          id: 'chat-workbench',
          name: '对话工作台',
          version: '1.0.0',
          services: [],
          components: [],
          ui: {
            views: [{ id: 'widget.chat-timeline', title: '对话', entry: 'index.html' }],
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
    ],
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function mountMain() {
  return mount(MainLayout, {
    global: { plugins: [createPinia()], stubs: { TopBar: true, DockviewLayout: true } },
  })
}

describe('MainLayout 主窗插件清单', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => catalog() })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('挂载时就 GET /api/plugins，并把 ui.views 填进 store', async () => {
    mountMain()
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('/api/plugins')
    const plugins = usePluginStore()
    expect(plugins.views.map((plugin) => plugin.id)).toEqual(['chat-workbench'])
    expect(plugins.views[0]!.views.map((view) => view.id)).toEqual(['widget.chat-timeline'])
  })

  it('偏好也照旧拉（hydrated 置位）—— usePlugins 取代了原先单独的 plugins.bootstrap()', async () => {
    mountMain()
    await flushPromises()
    expect(usePluginStore().hydrated).toBe(true)
  })

  it('清单拉不到时不崩，views 保持空数组', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    mountMain()
    await flushPromises()
    expect(usePluginStore().views).toEqual([])
  })
})
