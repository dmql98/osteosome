import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EmptyState from '../../src/components/ui/EmptyState.vue'

describe('EmptyState', () => {
  it('渲染 icon/title/description/action', () => {
    const wrapper = mount(EmptyState, { props: { icon: '∅', title: '暂无服务', description: '请稍后重试' }, slots: { action: '<button>重试</button>' } })
    expect(wrapper.text()).toContain('∅')
    expect(wrapper.text()).toContain('暂无服务')
    expect(wrapper.text()).toContain('请稍后重试')
    expect(wrapper.find('button').text()).toBe('重试')
  })
})
