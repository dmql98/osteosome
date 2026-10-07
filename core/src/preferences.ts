/**
 * Core 偏好存储的读写（S3 新增）—— `userData/core/preferences.json`。
 *
 * 路径见 `config.preferencesFile`：P1 之后落在 `userData/core/` 下，与插件的数据
 * （`userData/plugin/<id>/`）**并列** —— Core 仍然解析这份文档里的
 * `plugins.*` / `ui.theme`，所以它需要一个专属命名空间。
 *
 * 抽成独立模块而不是留在 `sse-bridge/preferences.ts`，是因为**两个地方要读**：
 * 1. `sse-bridge` 的 `GET/PUT /api/preferences`（前端通道，服务人）
 * 2. `service-manager` 的 `preferences.get` 子服务 RPC —— 服务启动时读回自己的配置
 *    （如 provider 读用户自填的端点）。照 `credentials.get` 的先例：点对点 RPC，
 *    **不经总线、不落事件**，与「凭证值不过总线」是同一条纪律。
 *
 * ## 为什么返回 `corrupted` 而不只是容错
 *
 * 两条路径对「文件坏了」的**正确反应不同**，所以不能替它们决定：
 * - HTTP（人看）：回 500 + 错误信息，让用户知道偏好没存住 —— 静默回 `{}` 等于假装成功
 * - RPC（服务启动）：回 `{}` + 记日志，让服务照常起来 —— 偏好坏了不该连累整个系统起不来
 *
 * 这与插件侧 `ModelsStore` 的 `prefsCorrupted` 是同一套纪律：**标记出来，让调用方决定严不严**。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir, preferencesFile } from './config'

export interface PreferencesReadResult {
  /** 偏好对象；文件不存在 / 损坏 / 非对象时为 `{}` */
  value: Record<string, unknown>
  /** 文件存在但解析失败或不是 JSON 对象 */
  corrupted: boolean
}

/** 读偏好（不抛）。`corrupted` 让调用方决定是回 500 还是容错启动。 */
export function readPreferences(dataDir: string): PreferencesReadResult {
  const file = preferencesFile(dataDir)
  if (!existsSync(file)) return { value: {}, corrupted: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, corrupted: false }
    }
    return { value: {}, corrupted: true }
  } catch {
    return { value: {}, corrupted: true }
  }
}

/** 整体覆盖写偏好（调用方负责合并，语义与 `PUT /api/preferences` 一致） */
export function writePreferences(dataDir: string, value: Record<string, unknown>): void {
  // 目录是 `userData/core/`（P1 之后偏好落在 Core 自己的子命名空间），所以要建的是**它**
  const file = preferencesFile(dataDir)
  ensureDir(dirname(file))
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}
