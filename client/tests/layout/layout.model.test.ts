import { describe, expect, it } from 'vitest'
import { applyDefaultSlot, defaultWorkspace, fromDockviewGrid, parseWorkspace, serializeWorkspace, toDockviewGrid } from '../../src/layout/layout.model'
import type { Layout } from '../../src/layout/types'

describe('layout.model', () => {
  it('默认布局包含工作台 Pane', () => {
    expect(defaultWorkspace().dock).toEqual({ kind: 'row', children: [{ kind: 'pane', id: 'pane.hello' }] })
  })

  it('applyDefaultSlot 在指定区域插入 Pane', () => {
    const ws = defaultWorkspace()
    const next = applyDefaultSlot(ws, { id: 'pane.extra', slot: { area: 'right', index: 0 } })
    expect(next.dock).toMatchObject({ kind: 'row', children: [{ kind: 'pane', id: 'pane.extra' }, { kind: 'pane', id: 'pane.hello' }] })
  })

  it('dockview grid 往返保留 Pane 结构', () => {
    const layout: Layout = { kind: 'col', children: [{ kind: 'pane', id: 'pane.a' }, { kind: 'row', children: [{ kind: 'pane', id: 'pane.b' }, { kind: 'pane', id: 'pane.c' }] }] }
    const grid = toDockviewGrid(layout, new Map([['pane.a', { title: 'A' }], ['pane.b', { title: 'B' }], ['pane.c', { title: 'C' }]]))
    expect(grid.panels['pane.a']?.title).toBe('A')
    expect(fromDockviewGrid(grid)).toEqual(layout)
  })

  it('工作区序列化可解析，非法 JSON 返回 null', () => {
    const ws = defaultWorkspace()
    expect(parseWorkspace(serializeWorkspace(ws))).toEqual(ws)
    expect(parseWorkspace('not-json')).toBeNull()
  })
})
