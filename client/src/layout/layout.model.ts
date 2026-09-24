import { Orientation, type SerializedDockview } from 'dockview-core'
import type { Layout, PaneId, WorkspaceLayout } from './types'

export function defaultWorkspace(): WorkspaceLayout {
  return {
    dock: { kind: 'row', children: [{ kind: 'pane', id: 'pane.hello' }] },
    floating: [],
    windows: [],
  }
}

function insertAt(items: Layout[], item: Layout, index: number): Layout[] {
  const next = items.slice()
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item)
  return next
}

export function applyDefaultSlot(
  ws: WorkspaceLayout,
  pane: { id: PaneId; slot: { area: 'left' | 'right' | 'bottom'; index: number } },
): WorkspaceLayout {
  const item: Layout = { kind: 'pane', id: pane.id }
  const direction = pane.slot.area === 'bottom' ? 'col' : 'row'
  const current = ws.dock
  if (current.kind === direction) {
    return { ...ws, dock: { ...current, children: insertAt(current.children, item, pane.slot.index) } }
  }
  return { ...ws, dock: { kind: direction, children: [current, item] } }
}

function paneIds(layout: Layout): PaneId[] {
  if (layout.kind === 'pane') return [layout.id]
  return layout.children.flatMap(paneIds)
}

function toGridNode(
  layout: Layout,
  paneMeta: Map<PaneId, { title: string }>,
  panels: Record<string, SerializedDockview['panels'][string]>,
): SerializedDockview['grid']['root'] {
  if (layout.kind === 'pane') {
    const groupId = `group-${layout.id}`
    const group = { id: groupId, views: [layout.id], activeView: layout.id }
    panels[layout.id] = {
      id: layout.id,
      contentComponent: 'PaneView',
      title: paneMeta.get(layout.id)?.title ?? layout.id,
      params: { paneId: layout.id },
    }
    return { type: 'leaf', data: group }
  }
  return { type: 'branch', data: layout.children.map((child) => toGridNode(child, paneMeta, panels)) }
}

export function toDockviewGrid(
  layout: Layout,
  paneMeta: Map<PaneId, { title: string }>,
): SerializedDockview {
  const panels: Record<string, SerializedDockview['panels'][string]> = {}
  const rootLayout: Layout = layout.kind === 'pane' ? { kind: 'row', children: [layout] } : layout
  const root = toGridNode(rootLayout, paneMeta, panels)
  if (root.type !== 'branch') throw new Error('dockview grid root must be a branch')
  const groupIds = Object.keys(panels).map((id) => `group-${id}`)
  return {
    grid: { root, width: 0, height: 0, orientation: layout.kind === 'col' ? Orientation.VERTICAL : Orientation.HORIZONTAL },
    panels,
    activeGroup: groupIds[0],
  }
}

function isGridNode(value: unknown): value is SerializedDockview['grid']['root'] {
  return Boolean(value && typeof value === 'object' && 'type' in value && (value.type === 'leaf' || value.type === 'branch'))
}

function fromGridNode(node: SerializedDockview['grid']['root'], orientation: 'row' | 'col'): Layout {
  if (node.type === 'leaf') {
    const data = node.data as { views?: string[] }
    return { kind: 'pane', id: data.views?.[0] ?? 'pane.unknown' }
  }
  const childOrientation = orientation === 'row' ? 'col' : 'row'
  const children = (node.data as SerializedDockview['grid']['root'][]).map((child) => fromGridNode(child, childOrientation))
  return { kind: orientation, children }
}

export function fromDockviewGrid(grid: SerializedDockview): Layout {
  if (!isGridNode(grid.grid.root)) return { kind: 'pane', id: 'pane.unknown' }
  const orientation = grid.grid.orientation === Orientation.VERTICAL ? 'col' : 'row'
  return fromGridNode(grid.grid.root, orientation)
}

export function serializeWorkspace(ws: WorkspaceLayout): string {
  return JSON.stringify(ws)
}

export function parseWorkspace(json: string): WorkspaceLayout | null {
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object') return null
    const ws = value as Partial<WorkspaceLayout>
    if (!ws.dock || typeof ws.dock !== 'object' || !Array.isArray(ws.floating) || !Array.isArray(ws.windows)) return null
    if (!isLayout(ws.dock)) return null
    return { dock: ws.dock, floating: ws.floating, windows: ws.windows }
  } catch {
    return null
  }
}

function isLayout(value: unknown): value is Layout {
  if (!value || typeof value !== 'object') return false
  const layout = value as { kind?: unknown; id?: unknown; children?: unknown }
  if (layout.kind === 'pane') return typeof layout.id === 'string' && layout.id.length > 0
  if (layout.kind !== 'row' && layout.kind !== 'col') return false
  return Array.isArray(layout.children) && layout.children.length > 0 && layout.children.every(isLayout)
}

export function listPaneIds(layout: Layout): PaneId[] {
  return paneIds(layout)
}
