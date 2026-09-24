/**
 * 拓扑排序（RFC §3.3 / WS-3）—— inject → 有向图；环 / 未知依赖 → 拒绝启动（fail fast）。
 * 返回依赖优先（inject 在前、依赖者在后）的启动序列；停止时逆序。
 */
import type { Manifest } from '@osteosome/shared'

export class TopologyError extends Error {
  constructor(readonly reasons: string[]) {
    super(`topology: ${reasons.join('; ')}`)
    this.name = 'TopologyError'
  }
}

/** 拓扑排序；返回注入者先行的启动序列 */
export function topologicalOrder(manifests: Manifest[]): Manifest[] {
  const byId = new Map(manifests.map((m) => [m.id, m]))
  const state = new Map<string, 'visiting' | 'done'>()
  const errors: string[] = []
  const order: Manifest[] = []

  const visit = (id: string, chain: string[]): void => {
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'visiting') {
      errors.push(`cycle detected: ${[...chain, id].join(' -> ')}`)
      return
    }
    if (!byId.has(id)) {
      errors.push(`unknown inject: '${id}'`)
      return
    }
    state.set(id, 'visiting')
    const manifest = byId.get(id)!
    for (const dep of manifest.inject) {
      visit(dep, [...chain, id])
    }
    state.set(id, 'done')
    order.push(manifest)
  }

  for (const m of manifests) visit(m.id, [])
  if (errors.length > 0) throw new TopologyError(errors)
  return order
}