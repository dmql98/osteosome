/**
 * 极简 semver 的测试（P2）—— 它守的是「插件的 coreCompatibility 会不会被误判」。
 *
 * 重点不是解析对不对（那是 semver 规范的事），而是三条**我们的取舍**：
 * 1. fail closed：非法版本 / 非法约束一律判为「不满足」；
 * 2. 不支持 range 简写（`^1.2` / `1.x`）—— 支持一半比不支持更糟；
 * 3. 预发布版小于同号正式版。
 */
import { describe, expect, it } from 'vitest'
import { compareSemVer, describeRangeMismatch, parseSemVer, satisfiesRange } from '../src/semver'

function cmp(a: string, b: string): number {
  const x = parseSemVer(a)!
  const y = parseSemVer(b)!
  return compareSemVer(x, y)
}

describe('parseSemVer', () => {
  it('标准三段式', () => {
    expect(parseSemVer('3.1.4')).toMatchObject({ major: 3, minor: 1, patch: 4, prerelease: '' })
  })

  it('带预发布与 build 标识', () => {
    expect(parseSemVer('1.0.0-alpha.2')?.prerelease).toBe('alpha.2')
    expect(parseSemVer('1.0.0+build.7')?.prerelease).toBe('')
  })

  it('不合规的返回 null（不抛）—— 调用方决定 fail closed', () => {
    for (const bad of ['1.2', 'v1.2.3', '^1.2.3', '1.2.3.4', 'latest', '', '  ', 'x.y.z']) {
      expect(parseSemVer(bad), bad).toBeNull()
    }
  })

  it('非字符串 → null', () => {
    expect(parseSemVer(3)).toBeNull()
    expect(parseSemVer(undefined)).toBeNull()
  })
})

describe('compareSemVer', () => {
  it('主 / 次 / 修订逐段比', () => {
    expect(cmp('1.0.0', '2.0.0')).toBe(-1)
    expect(cmp('1.2.0', '1.3.0')).toBe(-1)
    expect(cmp('1.2.3', '1.2.4')).toBe(-1)
    expect(cmp('2.0.0', '1.9.9')).toBe(1)
    expect(cmp('1.2.3', '1.2.3')).toBe(0)
  })

  it('预发布 < 同号正式版', () => {
    expect(cmp('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(cmp('1.0.0', '1.0.0-alpha')).toBe(1)
  })

  it('预发布之间：数字段按数值、字符串段按字典序、数字段小于字符串段', () => {
    expect(cmp('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(cmp('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
  })
})

describe('satisfiesRange', () => {
  it('无约束 → 满足（插件不声明就都能跑）', () => {
    expect(satisfiesRange('0.1.0', undefined)).toBe(true)
    expect(satisfiesRange('0.1.0', {})).toBe(true)
  })

  it('闭区间：两端都含', () => {
    expect(satisfiesRange('3.1.0', { min: '3.1.0' })).toBe(true)
    expect(satisfiesRange('3.0.9', { min: '3.1.0' })).toBe(false)
    expect(satisfiesRange('3.9.9', { max: '4.0.0' })).toBe(true)
    expect(satisfiesRange('4.0.0', { max: '4.0.0' })).toBe(true)
    expect(satisfiesRange('4.0.1', { max: '4.0.0' })).toBe(false)
    expect(satisfiesRange('3.5.0', { min: '3.1.0', max: '4.0.0' })).toBe(true)
  })

  it('fail closed：Core 版本读不出来 → 一律不满足（而不是当成无约束放行）', () => {
    // 这条是刻意的：版本读不出来时若放行，插件会在错误的 Core 上装上，
    // 症状是运行期的怪问题；拦下来则是启动时的一句提示。
    expect(satisfiesRange('0.0.0-unknown', { min: '0.1.0' })).toBe(false)
    expect(satisfiesRange('not-a-version', { min: '0.1.0' })).toBe(false)
  })

  it('fail closed：约束本身写错 → 不满足（多一个 v 这种）', () => {
    expect(satisfiesRange('3.1.0', { min: 'v3.1.0' })).toBe(false)
    expect(satisfiesRange('3.1.0', { max: '^3.0.0' })).toBe(false)
  })
})

describe('describeRangeMismatch', () => {
  it('满足时返回空串（调用方只看有没有话要说）', () => {
    expect(describeRangeMismatch('0.1.0', undefined)).toBe('')
    expect(describeRangeMismatch('3.5.0', { min: '3.1.0', max: '4.0.0' })).toBe('')
  })

  it('不满足时给出人可读的原因 —— 直接进插件状态的 reason', () => {
    expect(describeRangeMismatch('0.1.0', { min: '9.0.0' })).toContain('要求 Core >= 9.0.0，当前 0.1.0')
    expect(describeRangeMismatch('0.1.0', { min: '0.1.0', max: '0.0.1' })).toContain('<= 0.0.1')
  })

  it('版本 / 约束写错时说清是哪一边写错了', () => {
    expect(describeRangeMismatch('garbage', { min: '1.0.0' })).toContain('无法解析 Core 版本')
    expect(describeRangeMismatch('1.0.0', { min: 'v1.0.0' })).toContain('min 不是合法版本')
  })
})
