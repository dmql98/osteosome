import type { WidgetDefinition } from './types'

export function defineWidget(definition: WidgetDefinition): WidgetDefinition {
  if (!definition?.id || !definition.title) throw new Error('widget definition requires id and title')
  return definition
}
