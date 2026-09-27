import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import PluginListWindow from '../../src/plugins/PluginListWindow.vue'

describe('PluginListWindow 插件列表独立窗', () => {
  it('无服务时显示空状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const wrapper = mount(PluginListWindow, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.text()).toContain('还没有插件')
    vi.unstubAllGlobals()
  })

  it('有服务时渲染已安装列表（含版本与状态）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ services: [{ id: 'hello', status: 'ready', version: '1.0.0' }] }) }),
    )
    const wrapper = mount(PluginListWindow, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.text()).toContain('已安装')
    expect(wrapper.text()).toContain('hello')
    expect(wrapper.text()).toContain('v1.0.0')
    expect(wrapper.text()).toContain('运行中')
    vi.unstubAllGlobals()
  })
})
