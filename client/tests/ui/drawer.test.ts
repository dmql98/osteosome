import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Drawer from '../../src/components/ui/Drawer.vue'

describe('Drawer', () => {
  it('按 side 渲染并可关闭', async () => {
    const wrapper = mount(Drawer, { props: { open: true, side: 'right', title: '设置' }, attachTo: document.body })
    expect(document.body.querySelector('.ui-drawer--right')).not.toBeNull()
    await document.body.querySelector<HTMLButtonElement>('.ui-drawer__header button')!.click()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    wrapper.unmount()
  })
})
