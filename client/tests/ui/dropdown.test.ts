import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Dropdown from '../../src/components/ui/Dropdown.vue'

describe('Dropdown', () => {
  it('打开菜单并选择值，禁用项不触发', async () => {
    const wrapper = mount(Dropdown, { props: { items: [{ label: '删除', value: 'delete', danger: true }, { label: '禁用', value: 'off', disabled: true }] } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
    await wrapper.findAll('[role="menuitem"]')[0].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['delete']])
  })
})
