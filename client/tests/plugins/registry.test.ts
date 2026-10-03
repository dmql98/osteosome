import { describe, expect, it } from 'vitest'
import {
  pluginForWidgetIn,
  toPluginViews,
  type PluginListResponse,
  type PluginSnapshot,
} from '../../src/plugins/registry'

/**
 * S7-3：插件清单的数据源从「前端常量」换成 Core。
 *
 * 这些用例现在验的是**派生逻辑**（快照 -> 视图模型），不是「清单里有什么」——
 * 后者已经由 core 侧的 plugin-registry 测试守着（那里能读到真实的 plugins/）。
 * 所以这里用手搓的快照，好处是能把每个边界情况都摆出来而不用改磁盘。
 */
function snapshot(over: Partial<PluginSnapshot> & { id: string }): PluginSnapshot {
  return {
    manifest: {
      id: over.id,
      name: over.id,
      version: '1.0.0',
      services: [],
      components: [],
      ...(over.manifest ?? {}),
    },
    installed: true,
    state: 'ready',
    reason: '',
    missingDependencies: [],
    missingOptional: [],
    unhealthyServices: [],
    readyServiceCount: 0,
    serviceStates: {},
    ...over,
  } as PluginSnapshot
}

describe('toPluginViews', () => {
  it('摊平 manifest，模板不用写 plugin.manifest.name', () => {
    const views = toPluginViews([
      snapshot({
        id: 'chat-workbench',
        manifest: {
          id: 'chat-workbench',
          name: '对话工作台',
          version: '1.0.0',
          icon: '💬',
          description: '会话 + 循环 + 路由',
          services: ['session', 'loop', 'llm'],
          components: ['widget.chat-timeline'],
        },
        readyServiceCount: 2,
      }),
    ])
    expect(views[0]).toMatchObject({
      id: 'chat-workbench',
      name: '对话工作台',
      icon: '💬',
      components: ['widget.chat-timeline'],
      totalServices: 3,
      readyServiceCount: 2,
    })
  })

  it('没有 icon 就退化成首字（模板直接当头像用，不能是空）', () => {
    const views = toPluginViews([snapshot({ id: 'workbench', manifest: { id: 'workbench', name: '工作台', version: '1', services: [], components: [] } })])
    expect(views[0]!.icon).toBe('工')
  })

  it('依赖的 label 取对方插件名 —— Core 只给 pluginId，文案得前端补', () => {
    const views = toPluginViews([
      snapshot({ id: 'chat-workbench', manifest: { id: 'chat-workbench', name: '对话工作台', version: '1', services: [], components: [], dependencies: [{ pluginId: 'models' }, { pluginId: 'credentials', optional: true }] } }),
      snapshot({ id: 'models', manifest: { id: 'models', name: '模型接入', version: '1', services: [], components: [] } }),
      snapshot({ id: 'credentials', manifest: { id: 'credentials', name: '凭证服务', version: '1', services: [], components: [] } }),
    ])
    expect(views[0]!.dependencies).toEqual([
      { pluginId: 'models', label: '模型接入', optional: false },
      { pluginId: 'credentials', label: '凭证服务', optional: true },
    ])
  })

  it('依赖指向未知插件时 label 退回 pluginId（不显示空白）', () => {
    const views = toPluginViews([
      snapshot({ id: 'a', manifest: { id: 'a', name: 'A', version: '1', services: [], components: [], dependencies: [{ pluginId: 'ghost' }] } }),
    ])
    expect(views[0]!.dependencies[0]!.label).toBe('ghost')
  })

  it('capabilities / components 缺省时给空数组而不是 undefined（模板直接 .length）', () => {
    const views = toPluginViews([
      snapshot({ id: 'a', manifest: { id: 'a', name: 'A', version: '1', services: [], components: [] } }),
    ])
    expect(views[0]!.capabilities).toEqual([])
    expect(views[0]!.description).toBe('')
  })

  it('状态原样带出，不在前端重算', () => {
    const views = toPluginViews([
      snapshot({ id: 'a', state: 'degraded', reason: '缺必需依赖: models', missingDependencies: ['models'] }),
    ])
    expect(views[0]).toMatchObject({ state: 'degraded', reason: '缺必需依赖: models', missingDependencies: ['models'] })
  })
})

describe('pluginForWidgetIn', () => {
  const views = toPluginViews([
    snapshot({ id: 'workbench', manifest: { id: 'workbench', name: '工作台', version: '1', services: [], components: ['widget.system-info', 'widget.settings'] } }),
    snapshot({ id: 'models', manifest: { id: 'models', name: '模型接入', version: '1', services: [], components: ['widget.llm-providers'] } }),
  ])

  it('反查组件归属', () => {
    expect(pluginForWidgetIn(views, 'widget.settings')?.id).toBe('workbench')
    expect(pluginForWidgetIn(views, 'widget.llm-providers')?.id).toBe('models')
  })

  it('未登记归属的组件返回 undefined —— 调用方必须视为「始终可用」', () => {
    expect(pluginForWidgetIn(views, 'widget.unknown')).toBeUndefined()
  })

  it('空清单时返回 undefined，不抛错（store 还没 hydrate 的窗口）', () => {
    expect(pluginForWidgetIn([], 'widget.settings')).toBeUndefined()
  })
})

describe('PluginListResponse 形状', () => {
  it('layer 与 plugins 分开：前端要靠 layer 区分「没装」和「装坏了」', () => {
    // 这是 Core 的契约，前端视图模型不能把它压扁成一个空数组
    const body: PluginListResponse = {
      layer: 'missing-dir',
      pluginsDir: '/nope',
      installOrder: [],
      problems: [],
      cycles: [],
      plugins: [],
    }
    expect(body.layer).toBe('missing-dir')
    expect(body.plugins).toEqual([])
    expect(toPluginViews(body.plugins)).toEqual([])
  })
})