import { beforeEach, describe, expect, it } from 'vitest'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import { useListPrefs, LIST_PREFS_KEY } from '../src/state/list-prefs'
import { useSessionMotion } from '../src/state/motion'

describe('useListPrefs（P0-9/10/11 本地偏好）', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('折叠 / 整组置顶 / 顺序 / 已读 都是响应式且持久化到 sessionStorage', () => {
    const prefs = useListPrefs()
    expect(prefs.isCollapsed('today')).toBe(false)
    prefs.toggleGroup('today')
    expect(prefs.isCollapsed('today')).toBe(true)

    prefs.toggleGroupPin('pin')
    expect(prefs.isGroupPinned('pin')).toBe(true)

    prefs.setOrder('today', ['a', 'b'])
    expect(prefs.orderFor('today')).toEqual(['a', 'b'])

    prefs.markSeen('a', 1000)
    expect(prefs.seenAt('a')).toBe(1000)
    expect(prefs.isUnread('a', new Date(2000).toISOString())).toBe(true)
    expect(prefs.isUnread('a', new Date(500).toISOString())).toBe(false)

    // 落盘了
    const stored = JSON.parse(sessionStorage.getItem(LIST_PREFS_KEY)!)
    expect(stored.collapsed).toContain('today')
    expect(stored.groupPinned).toContain('pin')
    expect(stored.order.today).toEqual(['a', 'b'])
  })

  it('坏 JSON → 回落默认偏好，不抛错、不清除（清空会丢用户排序）', () => {
    sessionStorage.setItem(LIST_PREFS_KEY, '{ not json')
    const prefs = useListPrefs()
    expect(prefs.isCollapsed('today')).toBe(false)
    expect(prefs.showPreview.value).toBe(true)
    // 原值仍在（等用户下一次写入覆盖）
    expect(sessionStorage.getItem(LIST_PREFS_KEY)).toBe('{ not json')
  })
})

describe('useSessionMotion（P0-14 运行态投影）', () => {
  let es: FakeEventSource
  beforeEach(() => {
    sse.close()
    es = installFakeEventSource()
  })

  it('按事件投影出每会话 motion（互不串味）', () => {
    const m = useSessionMotion()
    m.bind()
    expect(m.motionOf('a')).toBe('idle')

    es.emit('loop.state.changed', { requestId: 'A', sessionId: 'a', state: 'running' })
    expect(m.motionOf('a')).toBe('thinking')

    es.emit('loop.tool.executed', { requestId: 'A', sessionId: 'a', toolCallId: 't', name: 'x', arguments: '{}', ok: true, summary: '' })
    expect(m.motionOf('a')).toBe('working')

    es.emit('loop.token.streamed', { requestId: 'A', sessionId: 'a', token: 'x', index: 0, blockType: 'text' })
    expect(m.motionOf('a')).toBe('speaking')

    // reasoning token 不改状态（thinking/speaking 的前身）
    es.emit('loop.state.changed', { requestId: 'B', sessionId: 'b', state: 'running' })
    es.emit('loop.token.streamed', { requestId: 'B', sessionId: 'b', token: '想', index: 0, blockType: 'reasoning' })
    expect(m.motionOf('b')).toBe('thinking')

    // 不同会话互不影响
    expect(m.motionOf('a')).toBe('speaking')

    es.emit('loop.run.failed', { requestId: 'A', sessionId: 'a', error: { code: 'x', message: '' } })
    expect(m.motionOf('a')).toBe('error')

    es.emit('loop.state.changed', { requestId: 'B', sessionId: 'b', state: 'idle' })
    expect(m.motionOf('b')).toBe('success')
    m.dispose()
  })

  it('未知会话 → idle', () => {
    const m = useSessionMotion()
    expect(m.motionOf('nope')).toBe('idle')
  })
})
