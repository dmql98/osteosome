import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import PluginDetailWindow from '../../src/plugins/PluginDetailWindow.vue'

function mountDetail(pluginId: string) {
  return mount(PluginDetailWindow, { props: { pluginId }, global: { plugins: [createPinia()] } })
}

describe('PluginDetailWindow 插件详情独立窗', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('渲染介绍 / 能力 / 组件 / 依赖 / 危险区', async () => {
    const wrapper = mountDetail('plugin.service-manager')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('插件管理')
    expect(text).toContain('服务管理')
    expect(text).toContain('介绍')
    expect(text).toContain('能力')
    expect(text).toContain('service.restart')
    expect(text).toContain('组件（UI，用户装配）')
    expect(text).toContain('服务状态')
    expect(text).toContain('依赖')
    expect(text).toContain('危险区')
    expect(text).toContain('卸载插件')
  })

  it('每个组件有「加入窗口」按钮，点击给出反馈', async () => {
    const wrapper = mountDetail('plugin.workbench')
    await flushPromises()
    const addButtons = wrapper.findAll('button').filter((button) => button.text().includes('加入窗口'))
    expect(addButtons.length).toBe(3)
    await addButtons[0].trigger('click')
    expect(wrapper.text()).toContain('已加入')
  })

  it('未知插件显示不存在', async () => {
    const wrapper = mountDetail('plugin.nope')
    await flushPromises()
    expect(wrapper.text()).toContain('插件不存在')
  })
})
