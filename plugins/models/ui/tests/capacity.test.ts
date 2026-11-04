/**
 * 容量字段的读写（上下文窗口 / 最大输出）。
 *
 * 这一对函数是「存数字、显示短写」的唯一实现，所以只测它们自己的语义：
 * 空 ≠ 0、坏值 ≠ 0、K/M 是十进制、格式化的结果必须能被自己读回去。
 */
import { describe, expect, it } from 'vitest'
import { formatCapacity, parseCapacity } from '../src/capacity'

describe('parseCapacity', () => {
  it('空串 = 没填（与填 0 是两件事）', () => {
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('   ')).toBeUndefined()
  })

  it('认 K / M（十进制），大小写与空白都容错', () => {
    expect(parseCapacity('128K')).toBe(128_000)
    expect(parseCapacity(' 1m ')).toBe(1_000_000)
    expect(parseCapacity('0.5M')).toBe(500_000)
    expect(parseCapacity('32768')).toBe(32768)
  })

  it('读不懂返回 NaN —— 调用方必须把它当「不要提交」，而不是 0', () => {
    expect(Number.isNaN(parseCapacity('abc'))).toBe(true)
    expect(Number.isNaN(parseCapacity('128KB'))).toBe(true)
    expect(Number.isNaN(parseCapacity('-1K'))).toBe(true)
  })
})

describe('formatCapacity', () => {
  it('整数倍用 K / M，其余保持原样（否则来回一次就变形）', () => {
    expect(formatCapacity(128_000)).toBe('128K')
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(131_072)).toBe('131072')
  })

  it('往返：格式化 → 解析回同一个数', () => {
    for (const value of [8_000, 32_768, 128_000, 200_000, 1_000_000, 131_072]) {
      expect(parseCapacity(formatCapacity(value))).toBe(value)
    }
  })
})
