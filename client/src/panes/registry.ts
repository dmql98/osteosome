import { definePane } from './definition'
import type { PaneDefinition } from './types'
import { defaultWorkspace, applyDefaultSlot } from '../layout/layout.model'
import type { WorkspaceLayout } from '../layout/types'

const paneModules = import.meta.glob<{ default: PaneDefinition }>('../features/*/*-pane.vue', { eager: true })
const panes = new Map<string, PaneDefinition>()

for (const module of Object.values(paneModules)) {
  const definition = module.default
  if (!definition?.id || !definition.title) throw new Error('pane definition requires id and title')
  if (panes.has(definition.id)) throw new Error(`duplicate pane id: ${definition.id}`)
  panes.set(definition.id, { windowable: true, ...definition })
}

export { definePane }

export function getPane(id: string): PaneDefinition | undefined {
  return panes.get(id)
}

export function listPanes(): PaneDefinition[] {
  return [...panes.values()]
}

export function defaultPanelsFor(ws: WorkspaceLayout = defaultWorkspace()): WorkspaceLayout {
  let next = ws
  for (const pane of listPanes()) {
    if (pane.defaultSlot && !JSON.stringify(next).includes(`"${pane.id}"`)) next = applyDefaultSlot(next, { id: pane.id, slot: pane.defaultSlot })
  }
  return next
}
