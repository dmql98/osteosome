import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { Badge, MOTION_LABEL, PULSING_MOTIONS, StatusDot } from '@osteosome/ui'

describe('StatusDot', () => {
  it('按 motion 加对应类，且默认是 idle', () => {
    expect(mount(StatusDot).classes()).toContain('ui-status-dot--idle')
    expect(mount(StatusDot, { props: { motion: 'working' } }).classes()).toContain('ui-status-dot--working')
  })

  it('只有进行中的四种带 pulse 类（终态与 idle 静置）', () => {
    for (const m of PULSING_MOTIONS) {
      expect(mount(StatusDot, { props: { motion: m } }).classes()).toContain('ui-status-dot--pulse')
    }
    for (const m of ['idle', 'success', 'error'] as const) {
      expect(mount(StatusDot, { props: { motion: m } }).classes()).not.toContain('ui-status-dot--pulse')
    }
  })

  it('size 反映到内联宽高；label 缺省用中文表', () => {
    const w = mount(StatusDot, { props: { motion: 'thinking', size: 5 } })
    expect(w.attributes('style')).toContain('width: 5px')
    expect(w.attributes('aria-label')).toBe(MOTION_LABEL.thinking)
  })

  it('自定义 label 覆盖缺省', () => {
    const w = mount(StatusDot, { props: { motion: 'error', label: '上一轮失败' } })
    expect(w.attributes('aria-label')).toBe('上一轮失败')
    expect(w.attributes('title')).toBe('上一轮失败')
  })
})

describe('Badge', () => {
  it('variant 决定语义色类，默认 neutral', () => {
    expect(mount(Badge).classes()).toContain('ui-badge--neutral')
    expect(mount(Badge, { props: { variant: 'danger' } }).classes()).toContain('ui-badge--danger')
  })

  it('给 motion 时用 motion 令牌类（与 StatusDot 同一套色）', () => {
    const w = mount(Badge, { props: { motion: 'speaking' } })
    expect(w.classes()).toContain('ui-badge--motion-speaking')
    expect(w.classes()).not.toContain('ui-badge--neutral')
  })

  it('渲染默认插槽内容', () => {
    expect(mount(Badge, { slots: { default: '运行中' } }).text()).toBe('运行中')
  })
})
