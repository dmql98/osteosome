import { defineAsyncComponent, type Component } from 'vue'
import { defineWidget } from './definition'
import type { WidgetDefinition } from './types'

const widgetModules = import.meta.glob<{ default: WidgetDefinition }>('./*/*-widget.vue', { eager: true })
const widgets = new Map<string, WidgetDefinition>()

for (const module of Object.values(widgetModules)) {
  const definition = module.default
  if (!definition?.id || !definition.title) throw new Error('widget definition requires id and title')
  if (widgets.has(definition.id)) throw new Error(`duplicate widget id: ${definition.id}`)
  widgets.set(definition.id, definition)
}

export { defineWidget }

export function getWidget(id: string): WidgetDefinition | undefined {
  return widgets.get(id)
}

export function listWidgets(): WidgetDefinition[] {
  return [...widgets.values()]
}

export function widgetComponents(): Record<string, Component> {
  return Object.fromEntries(listWidgets().map((widget) => [widget.id, defineAsyncComponent(widget.component)]))
}

export function defaultWidgetIds(): string[] {
  return listWidgets().map((widget) => widget.id)
}
