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
  /**
   * P6 收尾之后，宿主注册表是**空的**。
   *
   * 这条断言的内容换过两次：先是六个 workbench 组件（系统信息 / 命令台 / 事件流 /
   * 服务管理 / 服务状态 / 设置）搬进插件，现在连 chat-workbench 三盒也搬了。
   * 每次换都把断言换成**当时真实的状态** —— 描述过去的断言会在某天开始毫无意义地绿着。
   *
   * 之所以敢让注册表空着：三个盒子由 Core 伺服在
   * `/plugins/chat-workbench/ui/index.html#…`，走 `resolveWidget` 的 iframe 分支，
   * 不再经过这里。这里留空不等于「没有盒子」。
   */
  it('宿主已无本地组件：chat-workbench 三盒迁进插件（注册表为空）', () => {
    expect(listWidgets(), 'P6 收尾：本地组件全部迁出').toEqual([])
    expect(getWidget('widget.session-list')).toBeUndefined()
    expect(getWidget('widget.chat-timeline')).toBeUndefined()
    expect(getWidget('widget.chat-composer')).toBeUndefined()
  })

  /**
   * 六个 workbench 组件必须**不在**注册表里。
   *
   * 与下面那条 `widget.llm-settings` 是同一个护栏，只是范围更大：
   * 组件搬进插件后，client 里若还留着 glob 能扫到的同名文件，
   * 就会出现两份实现 —— 而界面上看不出哪份是真的。
   * 这类 bug 靠肉眼 review 是查不出来的，靠这条断言一劳永逸。
   */
  it('已搬进 workbench 插件的六个组件不在宿主注册表里', () => {
    for (const id of [
      'widget.system-info',
      'widget.command-palette',
      'widget.event-stream',
      'widget.service-manager',
      'widget.service-status',
      'widget.settings',
    ]) {
      expect(getWidget(id), `仍残留在宿主注册表：${id}（P6 已搬进 plugins/workbench/ui/）`).toBeUndefined()
    }
  })

  /**
   * 断层回归（P4 WS-1）：插件声明了组件、注册表却扫不到 → 默认工作台开不出来。
   * 曾真实发生：`widget.session-list` 定义在 `features/session/session-list-pane.vue`、
   * `widget.settings` 在 `widgets/settings/settings-pane.vue`，两者都不匹配注册表的 glob
   * （只扫 `widgets/` 下以 `-widget.vue` 结尾的二级目录文件）。
   *
   * P6 之后这条对账的范围自然变小了：设置等六个组件已搬进 workbench 插件，
   * 它的 `plugin.json` 里 `components[]` 为空、由 `ui.views[]` 声明，
   * 于是这里要对账的只剩仍在宿主的 widget（P7 之后会是空集）。
   *
   * S7-3 把这份断言的**对账两端换对了**：左边从「前端常量」改成「Core 的 plugin.json」。
   * 前端常量在手时，两端同源，改错了也自洽；现在才真的能查出断层。
   *
   * P6 收尾后左边很可能是**空集**（两个插件都把组件迁成了 `ui.views[]`），所以这里
   * **不再要求 `declared.length > 0`** —— 那个要求在插件化完成时必然变假。
   * 对账本身照旧：只要哪天有人在 `components[]` 里声明了一个本地组件，
   * 而注册表的 glob 扫不到它，这条就红。空集时它安静通过，不是失效。
   */
  it('Core 清单里声明的每个组件都能被 getWidget 取到（跨端对账）', () => {
    const declared = declaredComponents()
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

  it('widgetComponents 以 widget id 为键注册组件 —— 现在没有可注册的了', () => {
    // P5 搬走 llm-settings，P6 搬走六个 workbench 组件，收尾时又搬走 chat-workbench 三盒。
    // 它们现在是 Core 伺服在 `/plugins/<id>/ui/` 的插件页面。
    // 这条守的是「宿主不再有第二份实现」：glob 若又扫到一个 `-widget.vue`，
    // 这里就会多出一条，与 registry.ts 的注册规则一并暴露。
    expect(widgetComponents(), 'P6 收尾：宿主不该再挂任何本地组件').toEqual({})
  })

  it('已搬走的组件不在注册表里（否则 client 里会留着第二份实现）', () => {
    expect(getWidget('widget.llm-settings')).toBeUndefined()
  })

  it('缺少 id 或 title 的定义被拒绝', () => {
    expect(() => defineWidget({ id: '', title: 'x', component: async () => ({ default: {} as never }) })).toThrow()
    expect(() => defineWidget({ id: 'x', title: '', component: async () => ({ default: {} as never }) })).toThrow()
  })
})
