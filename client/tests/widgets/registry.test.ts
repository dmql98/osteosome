import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { defineWidget, getWidget, listWidgets, widgetComponents } from '../../src/widgets/registry'

/**
 * 从**真实 plugins/ 目录**读组件声明。
 *
 * S7-3 之前这里读的是 `PLUGINS` 常量。改读磁盘不是为了绕过删掉的常量，
 * 而是因为这份对账现在更有意义：清单在 Core 那边（磁盘上的 plugin.json），
 * 组件注册在这边（前端 glob）。**断层就发生在这两者之间**，
 * 而前端那份常量曾经把断层的一端也握在手里，于是对账永远自洽、永远查不出问题。
 */
function declaredComponents(): string[] {
  const dir = path.join(__dirname, '..', '..', '..', 'plugins')
  if (!existsSync(dir)) return []
  const ids: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(dir, entry.name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { components?: string[] }
    ids.push(...(manifest.components ?? []))
  }
  return ids
}

describe('widget registry', () => {
  it('自动发现内置组件', () => {
    expect(getWidget('widget.service-status')?.title).toBe('服务状态')
    expect(getWidget('widget.system-info')?.title).toBe('系统信息')
    expect(getWidget('widget.command-palette')?.title).toBe('命令台')
    expect(getWidget('widget.event-stream')?.title).toBe('事件流')
    expect(getWidget('widget.service-manager')?.title).toBe('服务管理')
    expect(listWidgets().length).toBeGreaterThanOrEqual(6)
  })

  /**
   * 断层回归（P4 WS-1）：插件声明了组件、注册表却扫不到 → 默认工作台开不出来。
   * 曾真实发生：`widget.session-list` 定义在 `features/session/session-list-pane.vue`、
   * `widget.settings` 在 `widgets/settings/settings-pane.vue`，两者都不匹配注册表的 glob
   * （只扫 `widgets/` 下以 `-widget.vue` 结尾的二级目录文件）。
   *
   * S7-3 把这份断言的**对账两端换对了**：左边从「前端常量」改成「Core 的 plugin.json」。
   * 前端常量在手时，两端同源，改错了也自洽；现在才真的能查出断层。
   */
  it('Core 清单里声明的每个组件都能被 getWidget 取到（跨端对账）', () => {
    const declared = declaredComponents()
    expect(declared.length).toBeGreaterThan(0)
    for (const id of declared) {
      expect(getWidget(id), `组件未注册：${id}（Core 声明了但前端没有）`).toBeDefined()
      expect(widgetComponents()[id], `组件未挂载：${id}`).toBeTruthy()
    }
  })

  it('反向也成立：注册表里没有孤儿组件（否则就是清单漏声明）', () => {
    const declared = new Set(declaredComponents())
    for (const widget of listWidgets()) {
      expect(declared.has(widget.id), `孤儿组件：${widget.id} 不属于任何插件`).toBe(true)
    }
  })

  it('widgetComponents 以 widget id 为键注册组件', () => {
    expect(widgetComponents()['widget.llm-providers']).toBeTruthy()
    expect(widgetComponents()['widget.system-info']).toBeTruthy()
    expect(widgetComponents()['widget.command-palette']).toBeTruthy()
    expect(widgetComponents()['widget.event-stream']).toBeTruthy()
    expect(widgetComponents()['widget.service-manager']).toBeTruthy()
  })

  it('缺少 id 或 title 的定义被拒绝', () => {
    expect(() => defineWidget({ id: '', title: 'x', component: async () => ({ default: {} as never }) })).toThrow()
    expect(() => defineWidget({ id: 'x', title: '', component: async () => ({ default: {} as never }) })).toThrow()
  })
})
