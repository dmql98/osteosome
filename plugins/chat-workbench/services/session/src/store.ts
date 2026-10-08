/**
 * 会话存储（P3-1 / 阶段 F M2）—— **SQLite** 持久化（唯一真相源）。
 *
 * ## 布局（`service.dataDir` 下）
 *
 * ```
 * sessions.db            → node:sqlite 库（sessions / messages 两表）
 * sessions.db.pre-*      → 迁移前备份（migrator 生成，不删）
 * sessions/              → 旧 JSONL 目录：**不再读取**（见详细计划 §4.3）
 * ```
 *
 * ## 相对 JSONL 的收益（为什么换）
 *
 * - `rename`：单列 `UPDATE`，不再重写全部消息（JSONL 解决不了）。
 * - 内存：**不再整会话常驻缓存** —— list/meta/get 全走 SQL，无界 Map 消失。
 * - `get`：可游标分页（M3），不再整份 messages 走 SSE。
 *
 * ## 缺省与边界
 *
 * - `node:sqlite` 绑不了 boolean → 写 `pinned/archived/corrupted` 前经 `toDbFlags`（0/1），读出经 `flag`。
 * - `workspaces` / `toolCalls` 以 JSON 文本存，读写经 `encodeJson` / `parseJsonArray`（坏值回退 `undefined`，不抛）。
 * - 多实例（两个 `SessionStore` 指向同一文件）：`appendMessage` 在 `BEGIN IMMEDIATE` 里算 `seq`，
 *   不会撞号；SQLite 自身串行化写。
 */
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { openDb, type Db, type SqlParam } from './db'
import { migrate } from './migrator'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  /** 归档（P2-2）。归档与置顶**都不改 updatedAt** —— 操作分类 ≠ 操作活动时间 */
  archived?: boolean
  /** 父会话 id（P2-3）—— 子代理会话在前端按它归组 */
  parentId?: string
  /** 最后一条 user/assistant 消息的预览（P2-4）—— 服务端拼一次，去前端 N+1 */
  lastMessage?: string
  /** 工作区（P7 M0）：项目根 + 额外授权根。**唯一写者 = 本服务** */
  workspace?: string
  workspaces?: string[]
  /** 会话在库中标记为损坏（读到但不可用）—— 调用方据此提示，不当正常会话 */
  corrupted?: boolean
}

export interface Message {
  id: string
  role: MessageRole
  createdAt: string
  content: string
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
  usage?: { promptTokens: number; completionTokens: number }
  /** S4：思维链（与 content 分开；正文里不含它） */
  reasoning?: string
  /** role:'tool'：对应 assistant.toolCalls[].id */
  toolCallId?: string
  /** role:'tool'：工具名（渲染与排查用） */
  toolName?: string
  /** role:'assistant'：本条发起的工具调用 */
  toolCalls?: { id: string; name: string; arguments: string }[]
}

export interface SessionFile {
  meta: SessionMeta
  messages: Message[]
}

/** 一页消息的游标信息（`session.get` 的结果用它翻页）。 */
export interface MessagePage {
  hasMore: boolean
  /** 本页最旧消息的 `seq`（字符串，对外当不透明游标）；无更早消息为 null。 */
  nextCursor: string | null
  /** 该会话消息总数。 */
  total: number
}

export interface NewMessage {
  role: MessageRole
  content: string
  finishReason?: Message['finishReason']
  usage?: Message['usage']
  /** S4：思维链（与 content 分开；正文里不含它） */
  reasoning?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: Message['toolCalls']
  /** 调用方自带 id（loop 回填时用；缺省生成） */
  id?: string
}

const DB_FILE = 'sessions.db'

/** 单会话内排序键的最大值保护（远够用；防 MAX() 返回 null）。 */
const FIRST_SEQ = 1

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 预览行文本（抄天枢 `cleanMessagePreview`）：去控制字符 → 压连续空白 → 截 120 **码点**。
 *
 * 用 `Array.from` 按码点截，避免把 emoji / 代理对劈成半个字符（`slice` 是 UTF-16 码元）。
 */
export function cleanMessagePreview(content: string): string {
  const cleaned = content
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, 120).join('')
}

/** boolean → 0/1（node:sqlite 绑不了 boolean）。 */
function toDbFlags(value: boolean | undefined): number {
  return value ? 1 : 0
}

/** 0/1（或 null）→ boolean | undefined。 */
function flag(value: number | null): boolean | undefined {
  return value === 1 ? true : undefined
}

/** 数组 → JSON 文本（空数组/null → null，保持列干净）。 */
function encodeJson(value: unknown[] | undefined): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  return JSON.stringify(value)
}

/** JSON 文本 → 数组（坏值 / 非数组 → undefined，不抛）。 */
function parseJsonArray(value: string | null): unknown[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

interface SessionRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  pinned: number
  archived: number
  parent_id: string | null
  last_message: string | null
  workspace: string | null
  workspaces: string | null
  corrupted: number
}

interface MessageRow {
  id: string
  session_id: string
  seq: number
  role: string
  created_at: string
  content: string
  finish_reason: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  reasoning: string | null
  tool_call_id: string | null
  tool_name: string | null
  tool_calls: string | null
}
function rowToMeta(r: SessionRow): SessionMeta {
  const workspaces = parseJsonArray(r.workspaces)?.filter((w): w is string => typeof w === 'string')
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(flag(r.pinned) ? { pinned: true } : {}),
    ...(flag(r.archived) ? { archived: true } : {}),
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
    ...(r.last_message ? { lastMessage: r.last_message } : {}),
    ...(r.workspace ? { workspace: r.workspace } : {}),
    ...(workspaces && workspaces.length > 0 ? { workspaces } : {}),
    ...(flag(r.corrupted) ? { corrupted: true } : {}),
  }
}

function rowToMessage(r: MessageRow): Message {
  const usage =
    r.prompt_tokens != null && r.completion_tokens != null
      ? { promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens }
      : undefined
  const toolCalls = parseJsonArray(r.tool_calls) as Message['toolCalls'] | undefined
  return {
    id: r.id,
    role: r.role as MessageRole,
    createdAt: r.created_at,
    content: r.content,
    ...(r.finish_reason ? { finishReason: r.finish_reason as NonNullable<Message['finishReason']> } : {}),
    ...(usage ? { usage } : {}),
    ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
    ...(r.tool_name ? { toolName: r.tool_name } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  }
}

const SESSION_COLUMNS =
  'id, title, created_at, updated_at, pinned, archived, parent_id, last_message, workspace, workspaces, corrupted'
const MESSAGE_COLUMNS =
  'id, role, created_at, content, finish_reason, prompt_tokens, completion_tokens, reasoning, tool_call_id, tool_name, tool_calls'

export class SessionStore {
  private readonly dbPath: string
  private readonly db: Db

  constructor(dataDir: string) {
    if (!dataDir) throw new Error('SessionStore: dataDir is required')
    mkdirSync(dataDir, { recursive: true })
    this.dbPath = join(dataDir, DB_FILE)
    this.db = openDb(this.dbPath)
    migrate(this.db, { dbPath: this.dbPath })
  }

  /** 库文件路径（诊断/测试/备份用） */
  get root(): string {
    return this.dbPath
  }

  /** 关闭底层连接（测试/优雅退出用）。 */
  close(): void {
    this.db.close()
  }

  private metaById(id: string): SessionMeta | undefined {
    const row = this.db.prepare<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id)
    return row ? rowToMeta(row) : undefined
  }

  /** 列出全部会话（不含消息），按 updatedAt 倒序 */
  list(): SessionMeta[] {
    return this.db
      .prepare<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC, rowid DESC`)
      .all()
      .map(rowToMeta)
  }

  /** 全部会话 id（D5：给「逐个发 session.deleted」用，省掉 N 个对象拷贝） */
  ids(): Set<string> {
    return new Set(this.db.prepare<{ id: string }>('SELECT id FROM sessions').all().map((r) => r.id))
  }

  /** 单条元信息（事件发布用） */
  meta(id: string): SessionMeta | undefined {
    return this.metaById(id)
  }

  /** 读单个会话全文（按 seq 升序）；不存在返回 null */
  get(id: string): SessionFile | null {
    if (!id) return null
    const meta = this.metaById(id)
    if (!meta) return null
    const messages = this.db
      .prepare<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(id)
      .map(rowToMessage)
    return { meta, messages }
  }

  /**
   * 按游标取一页消息（P3-1 M3）—— 从新到旧取 `limit` 条，返回时**反转成升序**。
   *
   * `before` 缺省 = 最新一页；`before = 上一页的 nextCursor` 取更早一页。
   * 多取一条判断 `hasMore`，避免额外的存在性查询。
   */
  getPage(id: string, opts: { limit: number; before?: string }): { file: SessionFile; page: MessagePage } | null {
    if (!id) return null
    const meta = this.metaById(id)
    if (!meta) return null
    const limit = opts.limit > 0 ? Math.floor(opts.limit) : 1
    const before = opts.before !== undefined && opts.before !== '' ? Number(opts.before) : NaN
    const hasBefore = Number.isFinite(before)

    const sql = hasBefore
      ? `SELECT ${MESSAGE_COLUMNS}, seq FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`
      : `SELECT ${MESSAGE_COLUMNS}, seq FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
    const params: SqlParam[] = hasBefore ? [id, before, limit + 1] : [id, limit + 1]
    const rows = this.db.prepare<MessageRow>(sql).all(...params)

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const messages = pageRows.slice().reverse().map(rowToMessage)
    const oldest = pageRows.length > 0 ? pageRows[pageRows.length - 1].seq : null
    const total = this.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(id)?.c ?? 0

    return {
      file: { meta, messages },
      page: { hasMore, nextCursor: hasMore && oldest !== null ? String(oldest) : null, total },
    }
  }

  /** 创建会话（`parentId` 给子代理子会话用，P2-3） */
  create(title?: string, parentId?: string): SessionMeta {
    const createdAt = nowIso()
    const meta: SessionMeta = {
      id: newId('s'),
      title: title?.trim() || '新会话',
      createdAt,
      updatedAt: createdAt,
      ...(parentId ? { parentId } : {}),
    }
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, parent_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(meta.id, meta.title, meta.createdAt, meta.updatedAt, meta.parentId ?? null)
    return { ...meta }
  }

  /**
   * 重命名（不存在返回 null）。**只改这一列**（不再是 JSONL 的全量重写）。
   */
  rename(id: string, title: string): SessionMeta | null {
    const existing = this.metaById(id)
    if (!existing) return null
    const next = title.trim() || existing.title
    const updatedAt = nowIso()
    this.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(next, updatedAt, id)
    return this.metaById(id) ?? null
  }

  /**
   * 置顶 / 取消置顶（P2-1）。**不改 `updatedAt`** —— 操作分类不是操作活动时间，
   * 否则点一下置顶，会话就跳进「今天」最顶上、行尾时间也变。
   */
  setPinned(id: string, pinned: boolean): SessionMeta | null {
    if (!this.metaById(id)) return null
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(toDbFlags(pinned), id)
    return this.metaById(id) ?? null
  }

  /** 归档 / 取消归档（P2-2）。与置顶同一条纪律：不改 `updatedAt` */
  setArchived(id: string, archived: boolean): SessionMeta | null {
    if (!this.metaById(id)) return null
    this.db.prepare('UPDATE sessions SET archived = ? WHERE id = ?').run(toDbFlags(archived), id)
    return this.metaById(id) ?? null
  }

  /**
   * 合并式写工作区（P7 M0）：`workspace` 设项目根；`addRoot`/`removeRoot` 增删授权根。
   * **不改 `updatedAt`**（工作区是配置，不是活动时间）；`workspace` 唯一化、`workspaces` 保持加入序。
   */
  setWorkspace(
    id: string,
    patch: { workspace?: string; addRoot?: string; removeRoot?: string },
  ): SessionMeta | null {
    const existing = this.metaById(id)
    if (!existing) return null

    let workspace = existing.workspace
    if (typeof patch.workspace === 'string') {
      const w = patch.workspace.trim()
      workspace = w || undefined
    }
    let roots = existing.workspaces ? [...existing.workspaces] : []
    if (typeof patch.addRoot === 'string' && patch.addRoot.trim()) {
      const r = patch.addRoot.trim()
      if (!roots.includes(r)) roots.push(r)
    }
    if (typeof patch.removeRoot === 'string') {
      roots = roots.filter((r) => r !== patch.removeRoot)
    }

    this.db
      .prepare('UPDATE sessions SET workspace = ?, workspaces = ? WHERE id = ?')
      .run(workspace ?? null, encodeJson(roots.length > 0 ? roots : undefined), id)
    return this.metaById(id) ?? null
  }

  /** 删除（不存在返回 false）：删会话行，级联删其消息 */
  remove(id: string): boolean {
    const r = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return r.changes > 0
  }

  /** 清空全部（返回删除数量） */
  clear(): number {
    return this.db.withTransaction(() => {
      const count = this.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM sessions').get()?.c ?? 0
      this.db.exec('DELETE FROM messages')
      this.db.exec('DELETE FROM sessions')
      return count
    })
  }

  /**
   * 追加消息（append-only：一条 INSERT，成本与已有多条数无关）。
   * 成功返回完整消息；会话不存在/损坏返回 null。
   */
  appendMessage(id: string, input: NewMessage): Message | null {
    const existing = this.metaById(id)
    if (!existing || existing.corrupted) return null

    const message: Message = {
      id: input.id ?? newId('m'),
      role: input.role,
      createdAt: nowIso(),
      content: input.content,
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
    }

    return this.db.withTransaction(() => {
      const row = this.db
        .prepare<{ maxSeq: number | null }>('SELECT MAX(seq) AS maxSeq FROM messages WHERE session_id = ?')
        .get(id)
      const seq = (row?.maxSeq ?? FIRST_SEQ - 1) + 1

      const params: SqlParam[] = [
        message.id,
        id,
        seq,
        message.role,
        message.createdAt,
        message.content,
        message.finishReason ?? null,
        message.usage?.promptTokens ?? null,
        message.usage?.completionTokens ?? null,
        message.reasoning ?? null,
        message.toolCallId ?? null,
        message.toolName ?? null,
        encodeJson(message.toolCalls),
      ]
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, seq, role, created_at, content, finish_reason, prompt_tokens, completion_tokens, reasoning, tool_call_id, tool_name, tool_calls)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...params)

      // updatedAt 恒为消息时间；预览只取 user/assistant（tool 结果常是大段 JSON，不适合当预览）
      if (message.role === 'user' || message.role === 'assistant') {
        const preview = cleanMessagePreview(message.content)
        if (preview) {
          this.db.prepare('UPDATE sessions SET updated_at = ?, last_message = ? WHERE id = ?').run(message.createdAt, preview, id)
          return message
        }
      }
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(message.createdAt, id)
      return message
    })
  }
}
