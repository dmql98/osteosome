import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Textarea from '../../src/components/ui/Textarea.vue'

describe('Textarea', () => {
  it('输入触发 update:modelValue', async () => {
    const wrapper = mount(Textarea, { props: { modelValue: '' } })
    await wrapper.find('textarea').setValue('多行')
    expect(wrapper.emitted('update:modelValue')).toEqual([['多行']])
  })

  it('rows / placeholder 透传到元素', () => {
    const wrapper = mount(Textarea, { props: { modelValue: '', rows: 6, placeholder: '说点什么' } })
    expect(wrapper.find('textarea').attributes('rows')).toBe('6')
    expect(wrapper.find('textarea').attributes('placeholder')).toBe('说点什么')
  })

  it('disabled 时禁用', () => {
    const wrapper = mount(Textarea, { props: { modelValue: '', disabled: true } })
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined()
  })

  it('autoGrow 时输入后写入内联高度', async () => {
    const wrapper = mount(Textarea, { props: { modelValue: '', autoGrow: true } })
    const el = wrapper.find('textarea').element
    expect(el.style.height).toBe('')
    await wrapper.find('textarea').setValue('x')
    expect(el.style.height).not.toBe('')
  })

  it('autoGrow 关闭时不写内联高度', async () => {
    const wrapper = mount(Textarea, { props: { modelValue: '' } })
    await wrapper.find('textarea').setValue('x')
    expect(wrapper.find('textarea').element.style.height).toBe('')
  })
})
