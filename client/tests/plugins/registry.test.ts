import { describe, expect, it } from 'vitest'
import { getPlugin, listPlugins, pluginForWidget } from '../../src/plugins/registry'

describe('plugin registry', () => {
  it('每个插件的组件归属反查一致', () => {
    const plugins = listPlugins()
    expect(plugins.length).toBeGreaterThanOrEqual(3)
    for (const plugin of plugins) {
      expect(plugin.widgets.length).toBeGreaterThan(0)
      for (const widget of plugin.widgets) {
        expect(pluginForWidget(widget)?.id).toBe(plugin.id)
      }
    }
  })

  it('getPlugin / pluginForWidget', () => {
    expect(getPlugin('plugin.service-manager')?.widgets).toContain('widget.service-status')
    expect(getPlugin('plugin.service-manager')?.widgets).toEqual(['widget.service-status', 'widget.service-manager'])
    expect(pluginForWidget('widget.unknown')).toBeUndefined()
    expect(getPlugin('missing')).toBeUndefined()
  })
})
