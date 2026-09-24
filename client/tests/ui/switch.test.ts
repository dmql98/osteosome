import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Switch from '../../src/components/ui/Switch.vue'

describe('Switch', () => {
  it('role=switch + aria-checked 跟随 modelValue', () => {
    const off = mount(Switch, { props: { modelValue: false } })
    const on = mount(Switch, { props: { modelValue: true } })
    expect(off.attributes('role')).toBe('switch')
    expect(off.attributes('aria-checked')).toBe('false')
    expect(on.attributes('aria-checked')).toBe('true')
  })

  it('点击取反并触发 update:modelValue', async () => {
    const wrapper = mount(Switch, { props: { modelValue: false } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('disabled 时不触发 update', async () => {
    const wrapper = mount(Switch, { props: { modelValue: false, disabled: true } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('label / ariaLabel 透传', () => {
    const wrapper = mount(Switch, {
      props: { modelValue: true, label: '深色', ariaLabel: '切换深色模式' },
    })
    expect(wrapper.text()).toContain('深色')
    expect(wrapper.attributes('aria-label')).toBe('切换深色模式')
  })
})
