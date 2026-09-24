import { describe, expect, it } from 'vitest'
import { definePane, getPane, listPanes } from '../../src/panes/registry'
import { defaultPanelsFor } from '../../src/panes/registry'

describe('pane registry', () => {
  it('自动发现 hello pane 并生成默认布局', () => {
    expect(getPane('pane.hello')?.title).toBe('Hello')
    expect(listPanes().some((pane) => pane.id === 'pane.hello')).toBe(true)
    expect(defaultPanelsFor()).toMatchObject({ dock: { kind: 'row' } })
  })

  it('缺少 id 或 title 的定义被拒绝', () => {
    expect(() => definePane({ id: '', title: 'x', component: async () => ({ default: {} as never }) })).toThrow()
    expect(() => definePane({ id: 'x', title: '', component: async () => ({ default: {} as never }) })).toThrow()
  })
})
