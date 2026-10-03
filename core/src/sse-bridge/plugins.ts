/**
 * `GET /api/plugins` —— 插件清单（S7-2a）
 *
 * ## 为什么是 GET 而不是走 SSE
 *
 * 插件清单是**拉一次就够**的静态形状（装了哪些、谁依赖谁），变化频率极低
 * （装/卸插件）。状态跃迁已经由 `plugin.state.changed` 事件推给前端了。
 * 所以这里不塞进 SSE 的首帧 —— 那会让每个连上来的页面都先收一份全量清单。
 *
 * ## `layer` 字段是重点
 *
 * 前端必须能区分这三种情况，它们的处置完全不同：
 * · `disabled`    —— 用户/测试显式关掉了插件层，**不是故障**
 * · `missing-dir` —— 路径写错或没部署，**要报错**
 * · `empty`       —— 目录在但没清单，**多半是漏了 S7-5**
 *
 * 只回一个空数组的话，这三种在界面上长得一模一样 —— 「没有插件」，于是用户
 * 以为一切正常。所以 status 必须单独出去。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginRegistry } from '../service-manager/plugin-registry-runtime'
import { sendJson } from './util'

export function handlePlugins(
  _req: IncomingMessage,
  res: ServerResponse,
  registry: PluginRegistry | undefined,
): void {
  if (!registry) {
    // 与 credentials 的处理一致：没装配就是没这个能力，别假装返回空清单
    sendJson(res, 404, { error: 'plugin layer not enabled' })
    return
  }
  sendJson(res, 200, registry.list())
}