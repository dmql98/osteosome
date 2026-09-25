export type PaneId = string

export type LayoutMode = 'edit' | 'runtime'

/** 工作台的递归布局树；当前 Panel/Widget 工作台使用 dockview 快照，旧 Pane 兼容层仍复用该模型。 */
export type Layout =
  | { kind: 'pane'; id: PaneId }
  | { kind: 'row' | 'col'; children: Layout[] }

export interface WorkspaceLayout {
  dock: Layout
  floating: unknown[]
  windows: unknown[]
}

export interface PaneMeta {
  title: string
}
