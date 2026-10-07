import { describe, expect, it } from 'vitest'
import { bucketOf, timeAgo } from '../src/state/buckets'

const NOON = Date.parse('2024-06-12T12:00:00') // 周三
const iso = (s: string) => new Date(s).toISOString()

describe('bucketOf（P0-7 时间桶）', () => {
  it('归档优先于置顶：归档会话即便 pinned 也落归档桶', () => {
    expect(bucketOf({ pinned: true, archived: true, updatedAt: iso('2024-06-12T11:00:00') }, NOON)).toBe('archived')
  })

  it('置顶落在 pin 桶', () => {
    expect(bucketOf({ pinned: true, updatedAt: iso('2020-01-01T00:00:00') }, NOON)).toBe('pin')
  })

  it('今天 / 昨天 / 本周 / 更早', () => {
    expect(bucketOf({ updatedAt: iso('2024-06-12T09:00:00') }, NOON)).toBe('today')
    expect(bucketOf({ updatedAt: iso('2024-06-11T23:00:00') }, NOON)).toBe('yesterday')
    expect(bucketOf({ updatedAt: iso('2024-06-10T09:00:00') }, NOON)).toBe('week') // 周一
    expect(bucketOf({ updatedAt: iso('2024-06-01T09:00:00') }, NOON)).toBe('earlier')
  })

  it('坏时间戳 → earlier（不抛）', () => {
    expect(bucketOf({ updatedAt: 'not-a-date' }, NOON)).toBe('earlier')
  })
})

describe('timeAgo（P0-5 相对时间）', () => {
  const now = Date.parse('2024-06-12T12:00:00')
  it('刚刚 / 分钟 / 小时', () => {
    expect(timeAgo(iso('2024-06-12T11:59:30'), now)).toBe('刚刚')
    expect(timeAgo(iso('2024-06-12T11:30:00'), now)).toBe('30 分钟前')
    expect(timeAgo(iso('2024-06-12T09:00:00'), now)).toBe('3 小时前')
  })
  it('24h 后降级到 昨天 / M/D（不永远停在 N 天前）', () => {
    expect(timeAgo(iso('2024-06-11T09:00:00'), now)).toBe('昨天')
    expect(timeAgo(iso('2024-06-01T09:00:00'), now)).toBe('6/1')
  })
  it('坏时间戳 → 空串', () => {
    expect(timeAgo('nope', now)).toBe('')
  })
})
