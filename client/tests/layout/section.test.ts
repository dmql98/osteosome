import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Section from '../../src/components/layout/Section.vue'

describe('Section', () => {
  it('collapsible 切换内容并触发 toggle', async () => {
    const wrapper = mount(Section, { props: { title: '区块', collapsible: true, defaultOpen: true }, slots: { default: '内容' } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([[false]])
    expect(wrapper.find('.section__body').isVisible()).toBe(false)
  })
})
