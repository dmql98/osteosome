import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import PaneFrame from '../../src/panes/PaneFrame.vue'
import type { PaneDefinition } from '../../src/panes/types'

const definition: PaneDefinition = { id: 'pane.test', title: '测试', component: async () => ({ default: {} as never }) }

describe('PaneFrame', () => {
  it('渲染标题并触发 reset/detach/close', async () => {
    const wrapper = mount(PaneFrame, { props: { definition }, slots: { default: '内容' } })
    expect(wrapper.text()).toContain('测试')
    await wrapper.find('[aria-label="重置布局"]').trigger('click')
    await wrapper.find('[aria-label="拉出独立窗"]').trigger('click')
    await wrapper.find('[aria-label="关闭 Pane"]').trigger('click')
    expect(wrapper.emitted('reset')).toHaveLength(1)
    expect(wrapper.emitted('detach')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('onBeforeClose 返回 false 时不关闭', async () => {
    const wrapper = mount(PaneFrame, { props: { definition: { ...definition, onBeforeClose: vi.fn(() => false) } } })
    await wrapper.find('[aria-label="关闭 Pane"]').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
