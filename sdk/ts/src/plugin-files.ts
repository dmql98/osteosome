/**
 * 读插件自带文件（P5）—— `plugins.readFile` 的 SDK 侧薄封装。
 *
 * ## 这个 RPC 为什么存在
 *
 * 服务打成了**单文件**（P2 的 esbuild bundle），所以它没有任何 `require` 能解析到
 * `plugins/<id>/catalog.json`。但插件本来就该带自己的数据 —— 于是 Core 授予
 * 「读自己插件目录」的只读能力。
 *
 * ## 边界不在这里，在 Core
 *
 * 这个函数只是把 `{ path, content }` 的形状固定下来。真正的边界是 Core 那边：
 * **只读、只限自己插件目录、没有插件目录就拒绝**。
 * 所以这里不需要（也不该）再写一遍路径校验 —— 写第二遍只会漂移。
 *
 * ## 失败要当成正常结果处理
 *
 * Core 会用 JSON-RPC error 拒绝（文件不存在 / 越界 / 太大 / 该服务不属于任何插件）。
 * 这不是异常，是**契约的一部分**：一个不含 catalog.json 的插件是合法的（纯服务插件）。
 * 所以调用方要么显式处理，要么用 {@link loadPluginJson} 的宽松模式。
 */
import type { Service } from './service'

/** `plugins.readFile` 的请求方法名。跨进程契约，改它就是破坏性变更 */
export const PLUGIN_READ_FILE_METHOD = 'plugins.readFile'

export interface PluginReadFileOptions {
  /** 超时 ms（默认 5000）。读文件是本地操作，不该慢 */
  timeoutMs?: number
}

/** 读一个插件目录下的文件，返回其 utf8 内容 */
export async function readPluginFile(
  service: Service,
  path: string,
  options: PluginReadFileOptions = {},
): Promise<string> {
  const result = await service.call<{ content?: unknown }>(
    PLUGIN_READ_FILE_METHOD,
    { path },
    options.timeoutMs ?? 5000,
  )
  if (!result || typeof result.content !== 'string') {
    throw new Error(`plugins.readFile '${path}': Core did not return a string content`)
  }
  return result.content
}

/**
 * 读并 `JSON.parse` 一个插件自带文件。
 *
 * `required = false` 时返回 `{ ok: false, reason }` 而不是抛 —— 用在
 * 「有这个文件就增强，没有也照常工作」的地方（可选资源）。
 * `required = true` 时任何失败都抛：这时候缺文件就是**配错了**，静默继续只会把
 * 问题推到用户面前变成「这家厂商怎么不出现」。
 */
export async function loadPluginJson<T = unknown>(
  service: Service,
  path: string,
  options: PluginReadFileOptions & { required?: boolean } = {},
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let content: string
  try {
    content = await readPluginFile(service, path, options)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (options.required) throw err
    return { ok: false, reason }
  }
  try {
    return { ok: true, value: JSON.parse(content) as T }
  } catch (err) {
    // JSON 坏了**永远**是致命问题：文件在、却读不出内容，
    // 宽松模式在这里会退化成「静默用默认值」，那正是「界面上没有这家厂商」的成因。
    throw new Error(
      `plugin file '${path}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}