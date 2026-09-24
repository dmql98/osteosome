import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Button from '../../src/components/ui/Button.vue'

describe('Button', () => {
  it('点击触发 click', async () => {
    const wrapper = mount(Button, { slots: { default: '发送' } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('disabled 时不触发 click', async () => {
    const wrapper = mount(Button, { props: { disabled: true } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('loading 时禁用 + aria-busy', () => {
    const wrapper = mount(Button, { props: { loading: true } })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    expect(wrapper.find('button').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('.ui-spinner').exists()).toBe(true)
  })

  it('variant / size / type 映射到 class 与属性', () => {
    const wrapper = mount(Button, {
      props: { variant: 'danger', size: 'lg', type: 'submit' },
      slots: { default: '删除' },
    })
    const button = wrapper.find('button')
    expect(button.classes()).toContain('ui-button--danger')
    expect(button.classes()).toContain('ui-button--lg')
    expect(button.attributes('type')).toBe('submit')
  })
})
