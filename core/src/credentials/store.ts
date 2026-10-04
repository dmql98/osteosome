/**
 * 凭证存储（P4 WS-1）—— `userData/core/credentials.json`。
 *
 * 这是 Core 自己的数据：与插件的 `userData/plugin/<id>/` **并列**而不是被它取代
 * （Core 仍然解析 `preferences.json` 里的 `plugins.*` / `ui.theme`，所以它需要一个专属命名空间）。
 *
 * ⚠️ 插件化之后**密钥最终要归使用方插件**（llm-provider 的密钥该在它自己的目录里，
 * 因为那是它的服务与 UI 都要读到的东西）。那一版随 UI 搬迁一起做（P5），
 * 在此之前 Core 仍然替所有插件集中保管 —— 今天是这个状态，不假装已经改完。
 *
 * 结构：`{ [id]: { id, name, provider, kind: 'apiKey', value, createdAt, updatedAt } }`
 *
 * 安全红线（P4 §0.1 / §3.1）：**明文只存在本文件与请求内存中** ——
 * 事件（credential.saved/deleted）只带 `{ id, name, provider }`，**值永不入事件 / SSE / 前端**。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CredentialKind = 'apiKey'

export interface Credential {
  id: string
  name: string
  /** 归属 provider（如 'deepseek' / 'openai'） */
  provider: string
  kind: CredentialKind
  /** 明文值——只在本文件与请求内存，永不出事件/SSE */
  value: string
  createdAt: string
  updatedAt: string
}

/** 掩码展示（前端唯一可见形态）：sk-abc...xyz */
export interface MaskedCredential {
  id: string
  name: string
  provider: string
  kind: CredentialKind
  masked: string
  createdAt: string
  updatedAt: string
}

export class CredentialStoreError extends Error {
  constructor(readonly reason: 'corrupted' | 'not_found', message: string) {
    super(message)
    this.name = 'CredentialStoreError'
  }
}

export function newCredentialId(): string {
  return `cred_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** 掩码：短值整体打码；长值保留头 4 尾 4 */
export function maskValue(value: string): string {
  if (value.length <= 8) return '•'.repeat(Math.max(value.length, 4))
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

export class CredentialStore {
  private readonly file: string
  private data: Record<string, Credential> = {}
  /** 索引文件损坏 → true（服务可启但凭证操作报错态，不崩 Core） */
  private corrupted = false

  constructor(dataDir: string) {
    // 落在 `userData/core/` 下（Core 自己的命名空间，见文件头）
    const dir = join(dataDir, 'core')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'credentials.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.data = {}
      this.corrupted = false
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      const out: Record<string, Credential> = {}
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const c = value as Partial<Credential>
        if (typeof c?.id !== 'string' || typeof c.value !== 'string') continue // 脏条目跳过
        out[c.id ?? id] = {
          id: c.id ?? id,
          name: typeof c.name === 'string' ? c.name : '',
          provider: typeof c.provider === 'string' ? c.provider : '',
          kind: c.kind === 'apiKey' ? 'apiKey' : 'apiKey',
          value: c.value,
          createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso(),
          updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : nowIso(),
        }
      }
      this.data = out
      this.corrupted = false
    } catch {
      // 损坏 → 空数据 + corrupted 标记（不崩 Core；后续 set 会重建文件）
      this.data = {}
      this.corrupted = true
    }
  }

  /** 原子写：临时文件 + rename（Windows 不能覆盖 → 先删旧） */
  private save(): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      if (existsSync(this.file)) rmSync(this.file, { force: true })
      renameSync(tmp, this.file)
      this.corrupted = false
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  isCorrupted(): boolean {
    return this.corrupted
  }

  /** 掩码列表（前端/事件唯一可见形态） */
  maskedList(): MaskedCredential[] {
    return Object.values(this.data)
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

  /** 取原值（**只给服务进程 / Core 内部**；前端通道永不走这里） */
  get(id: string): Credential {
    if (this.corrupted) throw new CredentialStoreError('corrupted', 'credentials store is corrupted')
    const c = this.data[id]
    if (!c) throw new CredentialStoreError('not_found', `no credential '${id}'`)
    return c
  }

  /** 新建或覆盖（id 缺省新建）；返回掩码形态（调用方据此发事件，不带 value） */
  set(input: { id?: string; name: string; provider: string; value: string; kind?: CredentialKind }): MaskedCredential {
    if (this.corrupted) throw new CredentialStoreError('corrupted', 'credentials store is corrupted')
    const id = input.id ?? newCredentialId()
    const now = nowIso()
    const existing = this.data[id]
    const credential: Credential = {
      id,
      name: input.name?.trim() || id,
      provider: input.provider?.trim() || '',
      kind: input.kind ?? 'apiKey',
      value: input.value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.data[id] = credential
    this.save()
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

  delete(id: string): boolean {
    if (this.corrupted) throw new CredentialStoreError('corrupted', 'credentials store is corrupted')
    if (!this.data[id]) return false
    delete this.data[id]
    this.save()
    return true
  }
}
