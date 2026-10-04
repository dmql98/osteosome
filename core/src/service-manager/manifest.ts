/**
 * Manifest 加载与校验（RFC §3.2 / §6.2 / WS-3）。
 * 扫描 `services/<id>/service.json`；schema / protocolVersion / 事件一致性任一不过 → fail fast。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  COMMAND_TOPICS,
  EVENT_TOPICS,
  ManifestSchema,
  PROTOCOL_VERSION,
  type Manifest,
} from '@osteosome/shared'

export class ManifestError extends Error {
  constructor(readonly reasons: string[]) {
    super(`manifest: ${reasons.join('; ')}`)
    this.name = 'ManifestError'
  }
}

export interface LoadedService {
  manifest: Manifest
  /** 服务目录（services/<id>/） */
  dir: string
}

/** 校验单个 manifest（schema / 协议版本 / 事件一致性） */
export function validateManifest(raw: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new ManifestError([`schema invalid: ${detail}`])
  }
  const manifest = parsed.data

  if (manifest.protocolVersion !== PROTOCOL_VERSION) {
    throw new ManifestError([
      `[${manifest.id}] protocolVersion ${manifest.protocolVersion} incompatible with ${PROTOCOL_VERSION}`,
    ])
  }
  const eventSet = new Set<string>(EVENT_TOPICS)
  const commandSet = new Set<string>(COMMAND_TOPICS)
  for (const topic of manifest.publishes) {
    // publishes 允许「事件 + 命令」：能力位架构下服务间调用（主位→provider llm.provider.request、
    // provider→credentials credentials.resolve）也走总线命令，只有一个 publish 出口（WS-9 集成冒烟实证）。
    if (!eventSet.has(topic) && !commandSet.has(topic)) {
      throw new ManifestError([`[${manifest.id}] publishes '${topic}' not declared in shared EventMap/CommandMap`])
    }
  }
  for (const topic of manifest.subscribes) {
    if (!eventSet.has(topic) && !commandSet.has(topic)) {
      throw new ManifestError([
        `[${manifest.id}] subscribes '${topic}' not declared in shared EventMap/CommandMap`,
      ])
    }
  }
  return manifest
}

/** 扫描目录下所有服务的 service.json 并校验（收集全部错误，一次性抛） */
export function loadServices(servicesDir: string): LoadedService[] {
  if (!existsSync(servicesDir)) {
    throw new ManifestError([`services dir not found: ${servicesDir}`])
  }
  const reasons: string[] = []
  const loaded: LoadedService[] = []
  for (const name of readdirSync(servicesDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const manifestPath = path.join(servicesDir, name.name, 'service.json')
    if (!existsSync(manifestPath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      reasons.push(`[${name.name}] service.json parse failed: ${String(err)}`)
      continue
    }
    try {
      loaded.push({ manifest: validateManifest(raw), dir: path.join(servicesDir, name.name) })
    } catch (err) {
      if (err instanceof ManifestError) reasons.push(...err.reasons)
      else reasons.push(`[${name.name}] unexpected: ${String(err)}`)
    }
  }
  if (reasons.length > 0) throw new ManifestError(reasons)
  return loaded
}

/**
 * 扫**多个**服务目录并合并（P1：服务住在插件里，于是有多个根；P2：根是 `dist/server`）。
 *
 * ## 缺目录为什么跳过而不是抛
 *
 * 插件可以合法地不带服务（`plugins/workbench/` 只有 UI），也可能是**还没构建**
 * （`dist/server/` 不存在）。「根目录不存在」在这里是常态而不是配置错误 ——
 * 真正配置错误（某个服务自己的 service.json 坏了）仍然照抛。
 *
 * ## 一个根都没给 ≠ 一个根都不存在
 *
 * 这两件事必须分开：
 * - `roots = []` —— **没给根**（还没有任何插件被构建）→ 安静地返回空，服务不启动；
 * - `roots = [<dir>]`，而 `<dir>` 不存在 —— **给了但装配错了** → 抛。
 *   （显式 `--services` 指到一个不存在的目录就该当场炸，那等于部署者写错了路径。）
 *
 * ## 重复 id 为什么必须拦
 *
 * 单一根时代不可能重复；多根之后两个插件各声明一个同名服务会静默「后者覆盖前者」
 * —— 而进程 id / 路由名都是那个 id，症状是「服务随机启动了一个」，极难查。
 */
export function loadServicesFrom(roots: readonly string[]): LoadedService[] {
  if (roots.length === 0) return []
  const existing = roots.filter((root) => existsSync(root))
  if (existing.length === 0) {
    throw new ManifestError([`no services dir found among: ${roots.join(', ')}`])
  }
  const byId = new Map<string, LoadedService>()
  const owners = new Map<string, string>()
  for (const root of existing) {
    for (const loaded of loadServices(root)) {
      const id = loaded.manifest.id
      const prevOwner = owners.get(id)
      if (prevOwner !== undefined) {
        throw new ManifestError([
          `duplicate service id '${id}': ${prevOwner} and ${loaded.dir} both declare it`,
        ])
      }
      byId.set(id, loaded)
      owners.set(id, loaded.dir)
    }
  }
  return [...byId.values()]
}