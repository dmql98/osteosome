/**
 * models 插件的**用户数据仓库**（接入清单 + 密钥）—— `userData/plugin/models/` 的唯一写者。
 *
 * ## 为什么归这个服务
 *
 * 密钥是**使用方**的东西：只有 provider 进程会把它变成 `Authorization` 头。
 * 让它住在 `userData/plugin/models/credentials.json` 意味着
 * 「谁用谁保管」—— 明文只在本进程内存与这个文件里，不必再绕 Core 与凭证服务两次手。
 * 这条红线的**内容**没变（明文永不入事件 / SSE / 日志），只是路径更短了。
 *
 * 接入清单同理：它是「这家插件的用户配置」，与 Core 自己的布局/主题并列而不是寄居在
 * Core 的偏好里（`docs/插件化架构优化.html` §4 三层布局）。
 *
 * ## 为什么必须在 `service.start()` 之后构造
 *
 * `service.dataDir` 由握手响应带回，**start 之前恒为 `''`**（`sdk/ts` 的 `dataDir = ''` 初值）。
 * 在模块顶层用它建仓库，落盘位置就是 `''` —— 于是写进 `dist/server/.data/`（会话服务踩过的同一个坑）。
 * 所以构造点只有一个（`index.ts` 的 `main()`，紧跟 `start()`），
 * 而且这里对空目录**直接抛**：宁可不起来，也不要静默写到别处。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { emptyModelsPrefs, type MaskedCredential, type ModelsPrefs, type CredentialKind } from '@osteosome/shared'

/** 掩码：短值整体打码；长值保留头 4 尾 4 */
export function maskValue(value: string): string {
  if (value.length <= 8) return '•'.repeat(Math.max(value.length, 4))
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

export function newCredentialId(): string {
  return `cred_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

interface Credential {
  id: string
  name: string
  provider: string
  kind: CredentialKind
  /** 明文 —— 只在内存与文件里，永不出本进程 */
  value: string
  createdAt: string
  updatedAt: string
}

const nowIso = (): string => new Date().toISOString()

export class ModelsStoreError extends Error {
  constructor(readonly reason: 'corrupted' | 'not_found' | 'no_data_dir', message: string) {
    super(message)
    this.name = 'ModelsStoreError'
  }
}

export class ModelsStore {
  private readonly prefsFile: string
  private readonly credsFile: string
  private prefs: ModelsPrefs = emptyModelsPrefs()
  private creds: Record<string, Credential> = {}
  /** 文件损坏 → 标记出来，由上层决定要不要报警；**服务照常起来**（偏好坏了不该连累用户连不上模型） */
  prefsCorrupted = false
  credsCorrupted = false

  /**
   * @param dataDir 握手拿到的 `service.dataDir`（`<dataDir>/plugin/models/`）
   */
  constructor(dataDir: string) {
    if (!dataDir) {
      throw new ModelsStoreError('no_data_dir', 'ModelsStore: dataDir 为空 —— 必须在 service.start() 之后构造')
    }
    mkdirSync(dataDir, { recursive: true })
    this.prefsFile = join(dataDir, 'preferences.json')
    this.credsFile = join(dataDir, 'credentials.json')
    this.loadPrefs()
    this.loadCreds()
  }

  /** 两个数据文件各自的绝对路径（启动日志与排障用；不放进事件） */
  get files(): { prefs: string; credentials: string } {
    return { prefs: this.prefsFile, credentials: this.credsFile }
  }

  // ── preferences.json ─────────────────────────────────────────

  private loadPrefs(): void {
    if (!existsSync(this.prefsFile)) {
      this.prefs = emptyModelsPrefs()
      this.prefsCorrupted = false
      return
    }
    try {
      this.prefs = parsePrefs(JSON.parse(readFileSync(this.prefsFile, 'utf8')) as unknown)
      this.prefsCorrupted = false
    } catch {
      this.prefs = emptyModelsPrefs()
      this.prefsCorrupted = true
    }
  }

  getPrefs(): ModelsPrefs {
    return { ...this.prefs }
  }

  /**
   * 合并式写（`patch` 里没给的键保持原样）。
   *
   * 合并而不是整体覆盖：模型接入面板与别的视图可能同时改接入清单，
   * 整体覆盖会把对方那一半改动悄悄吃掉。
   */
  patchPrefs(patch: Partial<ModelsPrefs>): ModelsPrefs {
    const next: ModelsPrefs = {
      connectedVendors: Array.isArray(patch.connectedVendors)
        ? patch.connectedVendors.filter((x): x is string => typeof x === 'string')
        : this.prefs.connectedVendors,
      vendorOverrides: Array.isArray(patch.vendorOverrides)
        ? (patch.vendorOverrides as ModelsPrefs['vendorOverrides'])
        : this.prefs.vendorOverrides,
      enabledModels: Array.isArray(patch.enabledModels)
        ? patch.enabledModels.filter((x): x is string => typeof x === 'string')
        : this.prefs.enabledModels,
    }
    this.prefs = next
    this.writeAtomic(this.prefsFile, next)
    this.prefsCorrupted = false
    return this.getPrefs()
  }

  // ── credentials.json ────────────────────────────────────────

  private loadCreds(): void {
    if (!existsSync(this.credsFile)) {
      this.creds = {}
      this.credsCorrupted = false
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.credsFile, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      const out: Record<string, Credential> = {}
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        const c = value as Partial<Credential>
        if (typeof c?.id !== 'string' || typeof c.value !== 'string') continue // 脏条目跳过，不让一行坏数据带走整份
        out[c.id] = {
          id: c.id,
          name: typeof c.name === 'string' ? c.name : '',
          provider: typeof c.provider === 'string' ? c.provider : '',
          kind: 'apiKey',
          value: c.value,
          createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso(),
          updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : nowIso(),
        }
      }
      this.creds = out
      this.credsCorrupted = false
    } catch {
      this.creds = {}
      this.credsCorrupted = true
    }
  }

  /** 掩码列表 —— 前端与事件的唯一形态 */
  maskedCredentials(): MaskedCredential[] {
    return Object.values(this.creds)
      .map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        kind: c.kind,
        masked: maskValue(c.value),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 厂商 id → 凭证 id（注册时用它把厂商与密钥对上） */
  credentialIdByProvider(): Map<string, string> {
    const out = new Map<string, string>()
    for (const c of Object.values(this.creds)) {
      if (c.provider) out.set(c.provider, c.id)
    }
    return out
  }

  /** 新建或覆盖（id 缺省新建）；返回掩码形态 */
  putCredential(input: { id?: string; name: string; provider: string; value: string }): MaskedCredential {
    const id = input.id?.trim() || newCredentialId()
    const now = nowIso()
    const existing = this.creds[id]
    const credential: Credential = {
      id,
      name: input.name?.trim() || id,
      provider: input.provider?.trim() || '',
      kind: 'apiKey',
      value: input.value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.creds[id] = credential
    this.writeAtomic(this.credsFile, this.creds)
    this.credsCorrupted = false
    return {
      id,
      name: credential.name,
      provider: credential.provider,
      kind: credential.kind,
      masked: maskValue(credential.value),
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    }
  }

  deleteCredential(id: string): boolean {
    if (!this.creds[id]) return false
    delete this.creds[id]
    this.writeAtomic(this.credsFile, this.creds)
    return true
  }

  /**
   * 取明文 —— **只给本进程**（拼 Authorization 头）。
   *
   * 这是明文唯一的出口；调用方不得把它放进事件、返回值或日志。
   */
  credentialValue(id: string): string {
    const c = this.creds[id]
    if (!c) throw new ModelsStoreError('not_found', `no credential '${id}'`)
    return c.value
  }

  /** 原子写：临时文件 + rename（Windows 不能覆盖 → 先删旧）；失败时抛，**不吞**（密钥写失败必须让用户知道） */
  private writeAtomic(file: string, data: unknown): void {
    const tmp = `${file}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      if (existsSync(file)) rmSync(file, { force: true })
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }
}

/** 容错解析：脏结构退回缺省值，不让一行坏数据把接入清单清空 */
export function parsePrefs(parsed: unknown): ModelsPrefs {
  const base = emptyModelsPrefs()
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
  const p = parsed as Partial<ModelsPrefs>
  return {
    connectedVendors: Array.isArray(p.connectedVendors)
      ? p.connectedVendors.filter((x): x is string => typeof x === 'string')
      : base.connectedVendors,
    vendorOverrides: Array.isArray(p.vendorOverrides) ? (p.vendorOverrides as ModelsPrefs['vendorOverrides']) : base.vendorOverrides,
    enabledModels: Array.isArray(p.enabledModels)
      ? p.enabledModels.filter((x): x is string => typeof x === 'string')
      : base.enabledModels,
  }
}