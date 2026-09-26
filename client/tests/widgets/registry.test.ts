import { describe, expect, it } from 'vitest'
import { defineWidget, getWidget, listWidgets, widgetComponents } from '../../src/widgets/registry'

describe('widget registry', () => {
  it('自动发现内置组件', () => {
    expect(getWidget('widget.service-status')?.title).toBe('服务状态')
    expect(getWidget('widget.system-info')?.title).toBe('系统信息')
    expect(getWidget('widget.command-palette')?.title).toBe('命令台')
    expect(getWidget('widget.event-stream')?.title).toBe('事件流')
    expect(getWidget('widget.service-manager')?.title).toBe('服务管理')
    expect(listWidgets().length).toBeGreaterThanOrEqual(6)
  })

  it('widgetComponents 以 widget id 为键注册组件', () => {
    expect(widgetComponents()['widget.hello-command']).toBeTruthy()
    expect(widgetComponents()['widget.system-info']).toBeTruthy()
    expect(widgetComponents()['widget.command-palette']).toBeTruthy()
    expect(widgetComponents()['widget.event-stream']).toBeTruthy()
    expect(widgetComponents()['widget.service-manager']).toBeTruthy()
  })

  it('缺少 id 或 title 的定义被拒绝', () => {
    expect(() => defineWidget({ id: '', title: 'x', component: async () => ({ default: {} as never }) })).toThrow()
    expect(() => defineWidget({ id: 'x', title: '', component: async () => ({ default: {} as never }) })).toThrow()
  })
})
