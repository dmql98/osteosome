import { describe, expect, it } from 'vitest'
import { defineWidget, getWidget, listWidgets, widgetComponents } from '../../src/widgets/registry'

describe('widget registry', () => {
  it('自动发现内置组件', () => {
    expect(getWidget('widget.service-status')?.title).toBe('服务状态')
    expect(listWidgets().length).toBeGreaterThanOrEqual(2)
  })

  it('widgetComponents 以 widget id 为键注册组件', () => {
    expect(widgetComponents()['widget.hello-command']).toBeTruthy()
  })

  it('缺少 id 或 title 的定义被拒绝', () => {
    expect(() => defineWidget({ id: '', title: 'x', component: async () => ({ default: {} as never }) })).toThrow()
    expect(() => defineWidget({ id: 'x', title: '', component: async () => ({ default: {} as never }) })).toThrow()
  })
})
