/**
 * 数据目录路径工具（P1a WS-4）—— Core 侧 dataDir / services / dist 派生。
 * 服务进程内部的 serviceDataDir() 在 shared/paths.ts（单一真相源）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 确保目录存在（recursive），返回该目录绝对路径 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** `${dataDir}/preferences.json`（Core 自己的数据，不走 serviceDataDir 约定） */
export function preferencesFile(dataDir: string): string {
  return join(dataDir, 'preferences.json')
}
