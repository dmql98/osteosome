import { describe, expect, it, vi } from 'vitest'
import { applyDefaultLayout } from '../../src/panes/default-layout'

describe('applyDefaultLayout', () => {
  it('铺一个承载默认组件的原生面板', () => {
    const api = { addPanel: vi.fn(() => ({ id: 'panel.main' })) }
    applyDefaultLayout(api as never)
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ component: 'panel', params: { widgets: expect.any(Array) } }))
  })
})
