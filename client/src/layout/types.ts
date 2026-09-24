export type PaneId = string

export type Layout =
  | { kind: 'row'; children: Layout[] }
  | { kind: 'col'; children: Layout[] }
  | { kind: 'pane'; id: PaneId }

export interface WorkspaceLayout {
  dock: Layout
  floating: { paneId: PaneId; size: { w: number; h: number } }[]
  windows: { paneId: PaneId; rect: { x: number; y: number; w: number; h: number } }[]
}

export type LayoutMode = 'edit' | 'runtime'

export interface PaneMeta {
  title: string
}
