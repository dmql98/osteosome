/**
 * Provider 路由表（P2 WS-4）—— llm 能力主位进程内的 provider 存在性表。
 *
 * 由 `llm.provider.registered` / `llm.provider.unregistered` 事件维护：
 * - registered 加表（重复注册覆盖更新）；unregistered 删表。
 * - `list()` 供 P4 模型目录；`resolve()` 缺失 → undefined（调用方转 `unsupported_provider`）。
 *
 * 「存在性由插件决定」：本表只反映**装了什么 provider 服务**，不 import 任何 provider 实现。
 */
import type { ProviderDescriptor } from '@osteosome/shared'

export interface ProviderRoute extends ProviderDescriptor {}

const routes = new Map<string, ProviderRoute>()

/** 注册 / 更新 provider 路由（重复注册幂等覆盖） */
export function upsert(descriptor: ProviderDescriptor): void {
  if (!descriptor?.provider) throw new Error('routes: descriptor.provider is required')
  routes.set(descriptor.provider, { ...descriptor })
}

/** 摘除 provider 路由（不存在则静默） */
export function remove(provider: string): void {
  routes.delete(provider)
}

/** 按 provider 取路由；缺失返回 undefined（调用方转 unsupported_provider） */
export function resolve(provider: string): ProviderRoute | undefined {
  return routes.get(provider)
}

/** 列出全部 provider 路由（供 P4 模型目录 / 调试） */
export function list(): ProviderRoute[] {
  return [...routes.values()]
}

/** 测试钩子：清空路由表 */
export function clearRoutes(): void {
  routes.clear()
}
