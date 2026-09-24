import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Spinner from '../../src/components/ui/Spinner.vue'

describe('Spinner', () => {
  it('渲染 ring 并带 role=status', () => {
    const wrapper = mount(Spinner)
    expect(wrapper.find('.ui-spinner__ring').exists()).toBe(true)
    expect(wrapper.attributes('role')).toBe('status')
  })

  it('label 缺省不渲染文本，传入时渲染', () => {
    expect(mount(Spinner).find('.ui-spinner__label').exists()).toBe(false)
    expect(mount(Spinner, { props: { label: '加载中…' } }).text()).toContain('加载中…')
  })

  it('size 映射为内联宽高', () => {
    const wrapper = mount(Spinner, { props: { size: 24 } })
    expect(wrapper.attributes('style')).toContain('width: 24px')
    expect(wrapper.attributes('style')).toContain('height: 24px')
  })
})
