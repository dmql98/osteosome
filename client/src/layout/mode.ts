import type { DockviewApi, DockviewGroupPanel } from 'dockview-core'
import type { LayoutMode } from './types'

/**
 * 运行模式只锁「布局不能被改」，**不隐藏面板头**。
 *
 * 之前 `group.model.header.hidden = true` 把面板顶栏（tab 栏 + 表头动作）在运行模式下藏了，
 * 配合 `--hoverbar` 还要悬停才浮现。用户的反馈是「运行模式连工作台都会隐藏」——
 * 而运行模式是**默认且正常使用**的模式，面板头正是「当前在哪个面板、有哪些动作」的入口，
 * 藏起来等于让人以为面板不见了。
 *
 * `locked: 'no-drop-target'` 保留：那才是运行模式真正要防的（别把面板拖乱了）。
 */
export function applyModeToGroup(group: DockviewGroupPanel, mode: LayoutMode): void {
  group.locked = mode === 'runtime' ? 'no-drop-target' : false
}

export function applyModeToAllGroups(api: DockviewApi, mode: LayoutMode): void {
  for (const group of api.groups) applyModeToGroup(group, mode)
}
