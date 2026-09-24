import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Table from '../../src/components/ui/Table.vue'

describe('Table', () => {
  it('按 columns/rows 渲染并支持空态', () => {
    const wrapper = mount(Table, { props: { columns: [{ key: 'name', label: '名称' }], rows: [{ id: 1, name: 'A' }], rowKey: 'id' } })
    expect(wrapper.find('th').text()).toBe('名称')
    expect(wrapper.find('td').text()).toBe('A')
    const empty = mount(Table, { props: { columns: [{ key: 'name' }], rows: [], rowKey: 'id', emptyText: '空列表' } })
    expect(empty.text()).toContain('空列表')
  })
})
