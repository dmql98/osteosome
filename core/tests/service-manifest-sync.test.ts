/**
 * `service.json` 必须声明源码里用到的每一个 topic。
 *
 * Core 的 `manager.ts` 对 `bus.publish` / `bus.subscribe` 都做 manifest 白名单校验，
 * 但 SDK 的 `busRequest().catch()` **只 `logger.warn` 不抛** —— 漏声明不会让任何东西崩，
 * 表现是「命令发出去 202、总线上却零订阅者」，极难定位。
 *
 * 实证：`llm.provider.reannounce` 漏声明，模型服务商页永远收不到
 * `llm.provider.registered`（卡片区空白、点「连接」无反应）。
 * 本测试拦的就是这一类回归。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins')

const TOPIC_CALL = /service\.(subscribe|publish)\(\s*['"]([^'"]+)['"]/g

/**
 * 全部服务目录 —— P1 之后是 `plugins/<id>/services/<sid>/`（两级）。
 *
 * 这里刻意**不**复用 `loadServicesFrom`：那个是「全成功或抛」的装配路径，
 * 而本测试要在服务目录坏掉时也能扫出其余服务并逐个报告（它拦的正是「漏声明 topic」
 * 这类问题，不能因为另一个服务坏了就整体失效）。
 */
function serviceDirs(): string[] {
  const out: string[] = []
  for (const plugin of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    const root = path.join(PLUGINS_DIR, plugin.name, 'services')
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const dir = path.join(root, entry.name)
      if (entry.isDirectory() && existsSync(path.join(dir, 'service.json'))) out.push(dir)
    }
  }
  return out
}

/** 只扫 `src/**`：`dist` 是构建产物，`node_modules` 是 SDK 自己的订阅 */
function sourceFiles(dir: string): string[] {
  const src = path.join(dir, 'src')
  if (!existsSync(src)) return []
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(src)
  return out
}

/** 源码里实际调用的 topic → 所在文件（相对路径） */
function topicsCalled(dir: string, kind: 'subscribe' | 'publish'): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(TOPIC_CALL)) {
      if (match[1] !== kind) continue
      found.set(match[2], path.relative(dir, file))
    }
  }
  return found
}

function undeclared(
  kind: 'subscribe' | 'publish',
  manifestKey: 'subscribes' | 'publishes',
): string[] {
  const missing: string[] = []
  for (const dir of serviceDirs()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'service.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const declared = new Set(Array.isArray(manifest[manifestKey]) ? (manifest[manifestKey] as string[]) : [])
    for (const [topic, file] of topicsCalled(dir, kind)) {
      if (!declared.has(topic)) missing.push(`${path.basename(dir)}/${file} → ${topic}`)
    }
  }
  return missing
}

describe('service.json ↔ 源码 topic 声明同步', () => {
  it('源码里 service.subscribe() 的每个 topic 都已声明在 subscribes', () => {
    expect(undeclared('subscribe', 'subscribes')).toEqual([])
  })

  it('源码里 service.publish() 的每个 topic 都已声明在 publishes', () => {
    expect(undeclared('publish', 'publishes')).toEqual([])
  })
})
