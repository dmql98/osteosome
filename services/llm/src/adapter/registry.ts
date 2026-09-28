/**
 * Registry —— provider 路由（P2 §3.2 / WS-3）。
 * - `routeKey` = provider 名（如 'openrouter'；P4 加 'openai' / 'anthropic' 等）。
 * - 注册唯一性：重复注册抛错；resolve 缺失抛错。
 * - `list()` 返回 route 元数据（含 defaultModel，供 P4 模型目录用）。
 */
import type { LlmAdapter } from './types'

export interface AdapterRoute {
  provider: string
  defaultModel: string
}

type AdapterEntry = {
  adapter: LlmAdapter
} & AdapterRoute

const routes = new Map<string, AdapterEntry>()

/** 注册 provider 适配器（重复注册抛错） */
export function register(adapter: LlmAdapter): void {
  if (!adapter?.provider) throw new Error('registry: adapter.provider is required')
  if (routes.has(adapter.provider)) {
    throw new Error(`registry: provider '${adapter.provider}' already registered`)
  }
  routes.set(adapter.provider, {
    provider: adapter.provider,
    defaultModel: adapter.defaultModel,
    adapter,
  })
}

/** 按 provider 取适配器（缺失抛错） */
export function resolve(provider: string): LlmAdapter {
  const entry = routes.get(provider)
  if (!entry) {
    throw new Error(`registry: no adapter for provider '${provider}'`)
  }
  return entry.adapter
}

/** 列出全部已注册 route（provider + defaultModel），供 P4 模型目录用 */
export function list(): AdapterRoute[] {
  return [...routes.values()].map(({ provider, defaultModel }) => ({ provider, defaultModel }))
}

/** 测试钩子：清空注册表 */
export function clearRegistry(): void {
  routes.clear()
}
