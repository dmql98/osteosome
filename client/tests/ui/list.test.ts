import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import List from '../../src/components/ui/List.vue'

describe('List', () => {
  it('空态渲染 empty 插槽', () => {
    const wrapper = mount(List, { props: { items: [] }, slots: { empty: '没有项目' } })
    expect(wrapper.text()).toBe('没有项目')
  })

  it('点击项目触发索引', async () => {
    const wrapper = mount(List, { props: { items: ['A', 'B'] } })
    await wrapper.findAll('button')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([[1]])
  })
})
