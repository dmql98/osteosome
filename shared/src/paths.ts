/**
 * 数据目录约定（P1a §3.1）：
 * 每个服务只写自己的 `services/<id>/` 子目录。P4 的 llm 配置 /
 * P3 的会话等存储目录全部由本函数派生；`dataDir/credentials.json`
 * 是 Core 自己的数据，例外（不走此约定）。
 */
import { join, sep } from 'node:path'

/**
 * `${dataDir}/services/<serviceId>/`（带结尾分隔符，便于拼接子路径）
 */
export function serviceDataDir(dataDir: string, serviceId: string): string {
  return `${join(dataDir, 'services', serviceId)}${sep}`
}

/** 预校验：服务标识只允许小写字母数字与连字符（目录名安全） */
const SAFE_ID = /^[a-z0-9-]+$/

export function isValidServiceId(id: string): boolean {
  return SAFE_ID.test(id)
}