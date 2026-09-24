import type { PaneDefinition } from './types'

export function definePane(definition: PaneDefinition): PaneDefinition {
  if (!definition?.id || !definition.title) throw new Error('pane definition requires id and title')
  return { windowable: true, ...definition }
}
