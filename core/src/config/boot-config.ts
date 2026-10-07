/**
 * 引导配置 `<应用根>/ost.config.json` —— **唯一能改数据目录的地方**。
 *
 * ## 为什么要有这么一个文件
 *
 * `preferences.json` 住在数据目录里，而数据目录是这个文件要决定的东西。
 * 把「数据目录」存进偏好 = 鸡生蛋：下次启动不知道去哪读偏好。
 * 所以这个设置必须住在**数据目录之外**，且路径固定、启动最早可得。
 *
 * ## 优先级（见 `config.ts` 的 `loadConfig`）
 *
 * `--data` > `OST_DATA` > **本文件的 `dataDir`** > 缺省（`<应用根>/userData`）
 *
 * 前两级是给部署者/集成测试的逃生门，一旦给出就不会读本文件 ——
 * 否则「命令行明确指定的数据根」会被一份配置文件盖掉，那是意外而不是配置。
 *
 * ## 读失败一律当「没配」
 *
 * 文件不存在是常态（绝大多数人用缺省）。文件存在但**坏了**（JSON 非法 / 类型不对）
 * 也不能让 Core 起不来 —— 那等于一个手滑的配置文件把人锁在应用门外。
 * 所以坏文件只丢掉对应那一项并报警，其余配置照常生效。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from '../logger'
import { ensureDir } from './paths'

/** 引导配置的已知字段（未知字段读时忽略、写时保留） */
export interface BootConfig {
  /** 数据根绝对路径或相对应用根的路径 */
  dataDir?: string
}

/**
 * 读引导配置。**缺文件 / 坏 JSON / 字段类型不对 → 一律当作「没配这一项」**，
 * 不抛异常（见文件头：不能让配置文件把人锁在门外）。
 */
export function readBootConfig(file: string): BootConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    // ENOENT 是常态（还没配过），只对「文件在但读坏了」报警
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    if (!missing) logger.warn(`core: ignored unreadable ${file}: ${String(err)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(`core: ignored ${file}: not a JSON object`)
    return {}
  }
  const raw = (parsed as { dataDir?: unknown }).dataDir
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'string' || raw.trim() === '') {
    logger.warn(`core: ignored ${file}: dataDir must be a non-empty string`)
    return {}
  }
  return { dataDir: raw.trim() }
}

/**
 * 整份覆盖写回。
 *
 * - 基底是**原始 JSON** 而不是 {@link readBootConfig} 的结果 —— 后者只认已知字段，
 *   拿它当基底会把「不认识的字段」悄悄删掉，那不是「写一个设置」，那是「删配置」。
 * - `next.dataDir === undefined`（恢复缺省）时由 `JSON.stringify` 自动丢掉这个键。
 * - 读坏了 → 当空基底重写一份干净的：写入路径上没有「保留坏数据」这回事。
 *
 * 目录不存在时创建 —— 配置文件住在应用根，正常情况下它一定存在；
 * 建不出来说明应用根本身不可写，那是个该被看见的错误。
 */
export function writeBootConfig(file: string, next: BootConfig): void {
  let base: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>
    }
  } catch {
    base = {}
  }
  const merged: Record<string, unknown> = { ...base, ...next }
  ensureDir(dirname(file))
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}
