import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PageHeader from '../../src/components/layout/PageHeader.vue'

describe('PageHeader', () => {
  it('back 按钮触发 back', async () => {
    const wrapper = mount(PageHeader, { props: { title: '页面', back: true }, slots: { actions: '<button>操作</button>' } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })
})
