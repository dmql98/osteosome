import { describe, expect, it } from 'vitest'
import { TopologyError, topologicalOrder } from '../src/service-manager/topology'
import type { Manifest } from '@osteosome/shared'

function manifest(id: string, inject: string[] = []): Manifest {
  return {
    id,
    version: '1.0.0',
    protocolVersion: '1.0.0',
    entry: 'node index.js',
    inject,
    publishes: [],
    subscribes: [],
  }
}

describe('topology', () => {
  it('returns single service in order', () => {
    expect(topologicalOrder([manifest('a')]).map((m) => m.id)).toEqual(['a'])
  })

  it('orders linear dependency: starter before dependent', () => {
    const b = manifest('b', ['a'])
    const a = manifest('a')
    expect(topologicalOrder([a, b]).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('orders diamond dependency', () => {
    const c = manifest('c')
    const a = manifest('a', ['c'])
    const b = manifest('b', ['c'])
    const d = manifest('d', ['a', 'b'])
    const order = topologicalOrder([d, b, a, c]).map((m) => m.id)
    // c 必须先于 a/b，a/b 先于 d
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
  })

  it('rejects a cycle (fail fast)', () => {
    const a = manifest('a', ['b'])
    const b = manifest('b', ['a'])
    expect(() => topologicalOrder([a, b])).toThrow(TopologyError)
    expect(() => topologicalOrder([a, b])).toThrow(/cycle/)
  })

  it('rejects unknown inject', () => {
    const a = manifest('a', ['missing'])
    expect(() => topologicalOrder([a])).toThrow(TopologyError)
    expect(() => topologicalOrder([a])).toThrow(/unknown inject/)
  })

  it('rejects self-inject as cycle', () => {
    const a = manifest('a', ['a'])
    expect(() => topologicalOrder([a])).toThrow(/cycle/)
  })
})