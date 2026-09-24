import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Tabs from '../../src/components/ui/Tabs.vue'

describe('Tabs', () => {
  it('渲染 tab 并切换 modelValue', async () => {
    const wrapper = mount(Tabs, { props: { tabs: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], modelValue: 'a' }, slots: { 'tab:a': 'A 内容' } })
    expect(wrapper.find('[role="tabpanel"]').text()).toBe('A 内容')
    await wrapper.findAll('[role="tab"]')[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['b']])
  })
})
