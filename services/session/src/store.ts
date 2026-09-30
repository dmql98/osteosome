/**
 * 会话存储（P3 WS-1）—— dataDir JSON 持久化（唯一真相源，对齐 P1a §3.1 规范）。
 *
 * 布局（`serviceDataDir(dataDir, 'session')` 下）：
 * ```
 * sessions/
 *   index.json      → SessionMeta[]        索引（列表视图来源）
 *   <sessionId>.json → { meta, messages }  单会话全文
 * ```
 *
 * 关键语义：
 * - **原子写**：临时文件 + rename 替换（Windows 下 rename 不能覆盖，故先删旧文件再 rename；
 *   失败时清理临时文件，绝不留下半写坏档）。
 * - **损坏降级**：单个会话 JSON 解析失败 → 标记 `corrupted` 并跳过该会话，**不崩服务、不吞其它会话**；
 *   index.json 坏 → 退化为空索引（后续 create 会重建）。
 * - **消息 append-only**：`appendMessage` 只追加，不改既有消息（P3 数据模型 §3.1）。
 * - **index 与全文双写一致**：写全文后同步索引条目。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type MessageRole = 'system' | 'user' | 'assistant'

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  /** 索引或全文损坏（读到但不可用）——调用方据此提示，不当正常会话 */
  corrupted?: boolean
}

export interface Message {
  id: string
  role: MessageRole
  createdAt: string
  content: string
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
  usage?: { promptTokens: number; completionTokens: number }
}

export interface SessionFile {
  meta: SessionMeta
  messages: Message[]
}

export interface NewMessage {
  role: MessageRole
  content: string
  finishReason?: Message['finishReason']
  usage?: Message['usage']
  /** 调用方自带 id（loop 回填时用；缺省生成） */
  id?: string
}

const INDEX_FILE = 'index.json'

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export class SessionStore {
  private readonly dir: string
  private index: SessionMeta[] = []
  private readonly cache = new Map<string, SessionFile>()

  constructor(dataDir: string) {
    // 对齐 P1a §3.1：服务只写自己的 serviceDataDir(dataDir, serviceId)
    this.dir = join(dataDir, 'sessions')
    mkdirSync(this.dir, { recursive: true })
    this.loadIndex()
  }

  /** 根目录（诊断/测试用） */
  get root(): string {
    return this.dir
  }

  private loadIndex(): void {
    const file = join(this.dir, INDEX_FILE)
    if (!existsSync(file)) {
      this.index = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      this.index = Array.isArray(parsed) ? (parsed as SessionMeta[]).filter((m) => typeof m?.id === 'string') : []
    } catch {
      // 索引坏 → 退化为空（不崩服务；create 会重建索引文件）
      this.index = []
    }
  }

  private sessionFile(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /**
   * 原子写：临时文件 + rename。
   * Windows 的 rename 不能覆盖已存在文件 → 先删旧再 rename；
   * 失败时清理临时文件（不留半写坏档）。
   */
  private atomicWrite(file: string, data: string): void {
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, data, 'utf8')
      if (existsSync(file)) rmSync(file, { force: true })
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  private writeIndex(): void {
    this.atomicWrite(join(this.dir, INDEX_FILE), JSON.stringify(this.index, null, 2))
  }

  private writeSession(file: SessionFile): void {
    this.cache.set(file.meta.id, file)
    this.atomicWrite(this.sessionFile(file.meta.id), JSON.stringify(file, null, 2))
  }

  /** 读单个会话全文（懒加载 + 缓存）；不存在或损坏返回 null */
  get(id: string): SessionFile | null {
    if (!id) return null
    const cached = this.cache.get(id)
    if (cached) return cached
    const file = this.sessionFile(id)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionFile
      if (!parsed || typeof parsed !== 'object' || !parsed.meta || typeof parsed.meta.id !== 'string') {
        return this.markCorrupted(id)
      }
      const normalized: SessionFile = {
        meta: parsed.meta,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      }
      this.cache.set(id, normalized)
      return normalized
    } catch {
      return this.markCorrupted(id)
    }
  }

  /** 损坏降级：索引标 corrupted，返回 null（不抛、不吞其它会话） */
  private markCorrupted(id: string): null {
    this.cache.delete(id)
    const meta = this.index.find((m) => m.id === id)
    if (meta && !meta.corrupted) {
      meta.corrupted = true
      try {
        this.writeIndex()
      } catch {
        /* 索引写失败不阻断读取路径 */
      }
    }
    return null
  }

  /** 列出全部会话（索引视图；含 corrupted 标记） */
  list(): SessionMeta[] {
    return this.index.map((m) => ({ ...m }))
  }

  /** 创建会话 */
  create(title?: string): SessionMeta {
    const createdAt = nowIso()
    const meta: SessionMeta = {
      id: newId('s'),
      title: title?.trim() || '新会话',
      createdAt,
      updatedAt: createdAt,
    }
    this.index.push(meta)
    this.writeSession({ meta, messages: [] })
    this.writeIndex()
    return { ...meta }
  }

  /** 重命名（不存在返回 null） */
  rename(id: string, title: string): SessionMeta | null {
    const file = this.get(id)
    if (!file) return null
    const next = title.trim() || file.meta.title
    file.meta.title = next
    file.meta.updatedAt = nowIso()
    this.writeSession(file)
    this.syncIndex(file.meta)
    return { ...file.meta }
  }

  /** 删除（不存在返回 false） */
  remove(id: string): boolean {
    const idx = this.index.findIndex((m) => m.id === id)
    if (idx < 0) return false
    this.index.splice(idx, 1)
    this.cache.delete(id)
    this.writeIndex()
    rmSync(this.sessionFile(id), { force: true })
    return true
  }

  /** 清空全部（返回删除数量） */
  clear(): number {
    const ids = this.index.map((m) => m.id)
    for (const id of ids) {
      this.cache.delete(id)
      rmSync(this.sessionFile(id), { force: true })
    }
    this.index = []
    this.writeIndex()
    return ids.length
  }

  /**
   * 追加消息（append-only：只追加，不改既有消息）。
   * 成功返回完整消息；会话不存在/损坏返回 null。
   */
  appendMessage(id: string, input: NewMessage): Message | null {
    const file = this.get(id)
    if (!file) return null
    const message: Message = {
      id: input.id ?? newId('m'),
      role: input.role,
      createdAt: nowIso(),
      content: input.content,
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
    }
    file.messages.push(message)
    file.meta.updatedAt = message.createdAt
    this.writeSession(file)
    this.syncIndex(file.meta)
    return message
  }

  /** 同步索引条目（全文写入后调用，保证双写一致） */
  private syncIndex(meta: SessionMeta): void {
    const i = this.index.findIndex((m) => m.id === meta.id)
    if (i >= 0) this.index[i] = { ...meta }
    this.writeIndex()
  }
}
