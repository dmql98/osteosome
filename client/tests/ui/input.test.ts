import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Input from '../../src/components/ui/Input.vue'

describe('Input', () => {
  it('输入触发 update:modelValue', async () => {
    const wrapper = mount(Input, { props: { modelValue: '' } })
    await wrapper.find('input').setValue('hello')
    expect(wrapper.emitted('update:modelValue')).toEqual([['hello']])
  })

  it('回车触发 enter', async () => {
    const wrapper = mount(Input, { props: { modelValue: 'hi' } })
    await wrapper.find('input').trigger('keydown.enter')
    expect(wrapper.emitted('enter')).toEqual([['hi']])
  })

  it('clearable 显示清空按钮并清空 + 触发 clear', async () => {
    const wrapper = mount(Input, { props: { modelValue: 'abc', clearable: true } })
    const clear = wrapper.find('.ui-input__clear')
    expect(clear.exists()).toBe(true)
    await clear.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['']])
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('modelValue 为空时不显示清空按钮', () => {
    expect(
      mount(Input, { props: { modelValue: '', clearable: true } }).find('.ui-input__clear').exists(),
    ).toBe(false)
  })

  it('disabled 时输入框禁用', () => {
    const wrapper = mount(Input, { props: { modelValue: '', disabled: true } })
    expect(wrapper.find('input').attributes('disabled')).toBeDefined()
  })

  it('prefix / suffix 插槽渲染', () => {
    const wrapper = mount(Input, {
      props: { modelValue: '' },
      slots: { prefix: '前', suffix: '后' },
    })
    expect(wrapper.text()).toContain('前')
    expect(wrapper.text()).toContain('后')
  })
})
