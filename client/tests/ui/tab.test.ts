import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Tab from '../../src/components/ui/Tab.vue'

describe('Tab', () => {
  it('渲染 label 并在点击时抛出 select', async () => {
    const wrapper = mount(Tab, { props: { label: 'A' } })
    expect(wrapper.text()).toBe('A')
    await wrapper.trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
  })

  it('selected 设置 aria-selected，disabled 阻止点击', async () => {
    const wrapper = mount(Tab, { props: { label: 'B', selected: true, disabled: true } })
    expect(wrapper.attributes('aria-selected')).toBe('true')
    expect(wrapper.find('.ui-tab--active').exists()).toBe(true)
    await wrapper.trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })
})
