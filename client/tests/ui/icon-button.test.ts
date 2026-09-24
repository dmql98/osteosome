import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import IconButton from '../../src/components/ui/IconButton.vue'

describe('IconButton', () => {
  it('label 作为 aria-label（a11y 必填项）', () => {
    const wrapper = mount(IconButton, { props: { icon: '×', label: '关闭' } })
    expect(wrapper.attributes('aria-label')).toBe('关闭')
    expect(wrapper.text()).toBe('×')
  })

  it('点击触发 click', async () => {
    const wrapper = mount(IconButton, { props: { icon: '⤢', label: '拉出' } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('disabled 时不触发 click', async () => {
    const wrapper = mount(IconButton, { props: { icon: '×', label: '关闭', disabled: true } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('size 映射到 class', () => {
    expect(mount(IconButton, { props: { icon: '×', label: 'x', size: 'sm' } }).classes()).toContain(
      'ui-icon-button--sm',
    )
  })
})
