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
    if (!eventSet.has(topic)) {
      throw new ManifestError([`[${manifest.id}] publishes '${topic}' not declared in shared EventMap`])
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