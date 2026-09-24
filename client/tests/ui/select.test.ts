import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Select from '../../src/components/ui/Select.vue'

const OPTIONS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'DeepSeek（暂不可用）', value: 'deepseek', disabled: true },
]

describe('Select', () => {
  it('渲染全部选项', () => {
    const wrapper = mount(Select, { props: { modelValue: 'openai', options: OPTIONS } })
    const options = wrapper.findAll('option')
    expect(options).toHaveLength(3)
    expect(options[0].text()).toBe('OpenAI')
    expect(options[2].attributes('disabled')).toBeDefined()
  })

  it('选择触发 update:modelValue', async () => {
    const wrapper = mount(Select, { props: { modelValue: 'openai', options: OPTIONS } })
    await wrapper.find('select').setValue('anthropic')
    expect(wrapper.emitted('update:modelValue')).toEqual([['anthropic']])
  })

  it('placeholder 渲染为禁用首项', () => {
    const wrapper = mount(Select, {
      props: { modelValue: '', options: OPTIONS, placeholder: '选择服务商' },
    })
    const first = wrapper.findAll('option')[0]
    expect(first.text()).toBe('选择服务商')
    expect(first.attributes('disabled')).toBeDefined()
  })

  it('disabled 时禁用', () => {
    const wrapper = mount(Select, { props: { modelValue: '', options: OPTIONS, disabled: true } })
    expect(wrapper.find('select').attributes('disabled')).toBeDefined()
  })
})
