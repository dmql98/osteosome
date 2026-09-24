import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Toast from '../../src/components/ui/Toast.vue'

describe('Toast', () => {
  it('命令式 toast 渲染消息并可关闭', async () => {
    const wrapper = mount(Toast, { attachTo: document.body })
    const vm = wrapper.vm as unknown as { toast: (message: string) => number }
    vm.toast('已保存')
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('已保存')
    await document.body.querySelector<HTMLButtonElement>('.ui-toast button[aria-label="关闭"]')!.click()
    expect(document.body.textContent).not.toContain('已保存')
    wrapper.unmount()
  })
})
