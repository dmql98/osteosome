import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Checkbox from '../../src/components/ui/Checkbox.vue'

describe('Checkbox', () => {
  it('勾选触发 update:modelValue', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false } })
    await wrapper.find('input').setValue(true)
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('label 文案渲染且 input 嵌套其中（原生关联：点 label 即切换）', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, label: '启用' } })
    expect(wrapper.text()).toContain('启用')
    expect(wrapper.find('label > input.ui-checkbox__input').exists()).toBe(true)
    await wrapper.find('input').setValue(true)
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('indeterminate 反映到 DOM 属性', () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, indeterminate: true } })
    expect((wrapper.find('input').element as HTMLInputElement).indeterminate).toBe(true)
  })

  it('disabled 时不触发 update', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, disabled: true } })
    expect(wrapper.find('input').attributes('disabled')).toBeDefined()
    await wrapper.find('input').trigger('change')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
