/**
 * 跨窗消息：插件列表 / 详情窗 → 主窗。
 *
 * - 详情窗的「加入窗口」需要把 widget 加进主窗当前激活面板；
 * - 列表 / 详情窗启用、停用、卸载插件后，主窗需要重算可见组件、并清理已卸载插件的组件。
 *
 * Tauri 环境用原生事件（emitTo('main', ...) / listen）；浏览器回退用 BroadcastChannel。
 * 事件名是跨窗契约，需与 Rust 壳 / 其它窗口保持一致。
 */
import { isTauri } from '../tauri/plugin-window'

/** 主窗口 label（与 tauri.conf.json 首窗默认 label 一致）。 */
export const MAIN_WINDOW_LABEL = 'main'
/** 请求主窗把某 widget 加入当前激活面板。 */
export const ADD_WIDGET_EVENT = 'ost:add-widget'
/** 插件状态（启用/停用/卸载）已变更，主窗应重读并收敛布局。 */
export const PLUGINS_CHANGED_EVENT = 'ost:plugins-changed'

const CHANNEL_NAME = 'osteosome-window-events'

type WindowMessage =
  | { type: 'add-widget'; widgetId: string }
  | { type: 'plugins-changed' }

let channel: BroadcastChannel | null = null

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  return channel
}

/** 详情窗调用：请求主窗把组件加入当前激活面板。 */
export function requestAddWidget(widgetId: string): void {
  if (isTauri()) {
    void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo(MAIN_WINDOW_LABEL, ADD_WIDGET_EVENT, widgetId))
    return
  }
  ensureChannel()?.postMessage({ type: 'add-widget', widgetId } satisfies WindowMessage)
}

/** 列表 / 详情窗调用：插件状态变更后通知主窗。 */
export function notifyPluginsChanged(): void {
  if (isTauri()) {
    void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo(MAIN_WINDOW_LABEL, PLUGINS_CHANGED_EVENT, null))
    return
  }
  ensureChannel()?.postMessage({ type: 'plugins-changed' } satisfies WindowMessage)
}

export interface MainWindowRequestHandlers {
  onAddWidget(widgetId: string): void
  onPluginsChanged(): void
}

/** 主窗订阅：返回取消订阅函数。 */
export async function onMainWindowRequest(handlers: MainWindowRequestHandlers): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event')
    const unlistenAdd = await listen<string>(ADD_WIDGET_EVENT, (event) => handlers.onAddWidget(event.payload))
    const unlistenChanged = await listen(PLUGINS_CHANGED_EVENT, () => handlers.onPluginsChanged())
    return () => {
      unlistenAdd()
      unlistenChanged()
    }
  }
  const bus = ensureChannel()
  if (!bus) return () => undefined
  const listener = (event: MessageEvent<WindowMessage>): void => {
    const data = event.data
    if (data?.type === 'add-widget') handlers.onAddWidget(data.widgetId)
    else if (data?.type === 'plugins-changed') handlers.onPluginsChanged()
  }
  bus.addEventListener('message', listener)
  return () => bus.removeEventListener('message', listener)
}
