import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import PluginListWindow from '../../src/plugins/PluginListWindow.vue'

function mountWindow() {
  return mount(PluginListWindow, { global: { plugins: [createPinia()] } })
}

describe('PluginListWindow 插件列表独立窗', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('渲染内置插件列表（名称 / 版本 / 组件数 / 状态）', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    expect(wrapper.text()).toContain('已安装 (3)')
    expect(wrapper.text()).toContain('工作台基础')
    expect(wrapper.text()).toContain('v1.0.0')
    expect(wrapper.text()).toContain('运行中')
  })

  it('启用/停用是动态按钮：已启用显示红色「禁用」，点击后变蓝色「启用」', async () => {
    const wrapper = mountWindow()
    await flushPromises()
    const toggle = wrapper.findAll('.plugin-toggle')[0]
    expect(toggle.text()).toBe('禁用')
    expect(toggle.classes()).toContain('plugin-toggle--disable')
    await toggle.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.plugin-toggle')[0].text()).toBe('启用')
    expect(wrapper.findAll('.plugin-toggle')[0].classes()).toContain('plugin-toggle--enable')
  })

  it('点击管理打开插件详情独立窗', async () => {
    const popup = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const wrapper = mountWindow()
    await flushPromises()
    const manage = wrapper.findAll('button').find((button) => button.text() === '管理')
    expect(manage).toBeTruthy()
    await manage!.trigger('click')
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('#/plugin-detail/plugin.workbench'),
      expect.any(String),
      expect.any(String),
    )
  })
})
