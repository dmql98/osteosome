import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Card from '../../src/components/ui/Card.vue'

describe('Card', () => {
  it('渲染 title、body 与 footer 插槽', () => {
    const wrapper = mount(Card, { props: { title: '标题', hoverable: true }, slots: { default: '正文', footer: '底部' } })
    expect(wrapper.text()).toContain('标题')
    expect(wrapper.text()).toContain('正文')
    expect(wrapper.text()).toContain('底部')
    expect(wrapper.classes()).toContain('ui-card--hoverable')
  })
})
