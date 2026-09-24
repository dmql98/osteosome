import type { DockviewApi, DockviewGroupPanel } from 'dockview-core'
import type { LayoutMode } from './types'

export function applyModeToGroup(group: DockviewGroupPanel, mode: LayoutMode): void {
  group.locked = mode === 'runtime' ? 'no-drop-target' : false
  group.model.header.hidden = mode === 'runtime'
}

export function applyModeToAllGroups(api: DockviewApi, mode: LayoutMode): void {
  for (const group of api.groups) applyModeToGroup(group, mode)
}
