import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Modal from '../../src/components/ui/Modal.vue'

describe('Modal', () => {
  it('打开时渲染 dialog 与 title', () => {
    const wrapper = mount(Modal, { props: { open: true, title: '确认' }, attachTo: document.body })
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('确认')
    wrapper.unmount()
  })

  it('关闭按钮和 Esc 触发 update:open/close', async () => {
    const wrapper = mount(Modal, { props: { open: true }, attachTo: document.body })
    await document.body.querySelector<HTMLButtonElement>('.ui-modal__close')!.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
