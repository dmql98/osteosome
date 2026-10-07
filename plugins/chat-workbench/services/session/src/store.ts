/**
 * 会话存储（P3 WS-1；P4b P1 修订）—— dataDir **JSONL** 持久化（唯一真相源）。
 *
 * ## 布局（`pluginDataDir(dataDir, 'chat-workbench')` 下）
 *
 * ```
 * sessions/
 *   index.json        → SessionMeta[]            列表视图唯一来源（元信息权威）
 *   <sessionId>.jsonl → 首行 meta，其余每行一条 message   单会话全文
 *   <id>.<pid>.<uuid>.tmp  → 写索引期间的临时文件（唯一名，见 P1-4）
 * ```
 *
 * ## 为什么是 JSONL 而不是 JSON（P1-6 止血）
 *
 * 原来单会话是 `{ meta, messages }` 一个 JSON 文件，**每条消息 append 都全量重写整个文件**：
 * 实测平均 20 KB/条、5000 条时一次 append 要写 96 MB / 399 ms（优化计划 §6.1）。
 * 改成 JSONL 后 append 只是 `appendFileSync` 追加一行，**成本与已有多条数无关（O(1)）**。
 *
 * 代价：`rename` 仍要重写全部消息 —— 那是 JSONL 解决不了的，留给 P3-1（SQLite）。
 * 本版让 **index.json 成为 meta 的权威**，所以 rename 只改索引、不碰全文（O(1)）；
 * 全文首行的 meta 只是「索引丢失时的重建种子」，允许陈旧。
 *
 * ## 关键语义
 * - **原子写**：临时文件（唯一名）+ rename。**不再先删旧文件**（P1-1）—— rename 本身覆盖，
 *   删除到 rename 之间的窗口会让崩溃丢掉整个会话（D1）。
 * - **启动对账**（P1-3）：扫目录，**目录有、索引无** → 补进索引（读首行 meta）；
 *   **索引有、目录无** → 从索引剔除。修掉「索引坏 → 全部会话变孤儿且永不恢复」（D2）。
 * - **损坏降级**：单会话首行解析失败 → 标 `corrupted` 并跳过，不崩服务、不吞其它会话。
 * - **append-only**：`appendMessage` 只追加一行，不改既有消息。
 * - **删除顺序**（P1-2）：先 unlink 文件、再更新索引 —— 崩在中间是「索引有条、文件没了」，
 *   对账会正确丢弃它，而不是「文件还在、索引没了」导致它被对账**复活**。
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

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
  /** 索引或全文损坏（读到但不可用）—— 调用方据此提示，不当正常会话 */
  corrupted?: boolean
}

export interface Message {
  id: string
  role: MessageRole
  createdAt: string
  content: string
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
  usage?: { promptTokens: number; completionTokens: number }
  /** S4：思维链（与 content 分开；正文里不含它）。P1-5：类型补全（此前磁盘上有、类型上没有） */
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

const INDEX_FILE = 'index.json'
const JSONL_EXT = '.jsonl'
const LEGACY_EXT = '.json'

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

export class SessionStore {
  private readonly dir: string
  private index: SessionMeta[] = []
  /** 只缓存**消息数组**（meta 的权威在 index，不在此） */
  private readonly cache = new Map<string, Message[]>()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions')
    mkdirSync(this.dir, { recursive: true })
    this.loadIndex()
    this.reconcile()
  }

  /** 根目录（诊断/测试用） */
  get root(): string {
    return this.dir
  }

  private indexPath(): string {
    return join(this.dir, INDEX_FILE)
  }

  /** 全文文件名（优先 `.jsonl`，兼容旧 `.json`）—— 不存在返回 `.jsonl` 路径（新建用） */
  private sessionFile(id: string): string {
    const jsonl = join(this.dir, `${id}${JSONL_EXT}`)
    if (existsSync(jsonl)) return jsonl
    const legacy = join(this.dir, `${id}${LEGACY_EXT}`)
    if (existsSync(legacy)) return legacy
    return jsonl
  }

  private loadIndex(): void {
    const file = this.indexPath()
    if (!existsSync(file)) {
      this.index = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      this.index = Array.isArray(parsed) ? (parsed as SessionMeta[]).filter((m) => typeof m?.id === 'string') : []
    } catch {
      // 索引坏 → 先退化为空；紧接着 reconcile() 会从目录把它们全捞回来（P1-3）
      this.index = []
    }
  }

  /**
   * 启动对账（P1-3）：让索引与目录一致，并把旧 `.json` 迁移为 `.jsonl`。
   *
   * 三种修复：
   * 1. **目录有、索引无** → 补一条（读全文首行 meta；解析失败标 `corrupted`）；
   * 2. **索引有、目录无** → 从索引剔除（删到一半崩了留下的残索引）；
   * 3. **旧 `.json` 存在、`.jsonl` 不存在** → 迁移（见 `readFile` 的懒迁移），此处只在补索引时顺带读一次。
   */
  private reconcile(): void {
    const inIndex = new Set(this.index.map((m) => m.id))
    const onDisk = new Set<string>()

    for (const name of readdirSync(this.dir)) {
      if (name === INDEX_FILE || name.endsWith('.tmp')) continue
      const id = name.endsWith(JSONL_EXT)
        ? name.slice(0, -JSONL_EXT.length)
        : name.endsWith(LEGACY_EXT)
          ? name.slice(0, -LEGACY_EXT.length)
          : null
      if (!id) continue
      onDisk.add(id)
      if (inIndex.has(id)) continue
      // 目录有、索引无 → 从文件首行读 meta 补进索引
      const file = this.readFile(id)
      if (file) {
        this.index.push(file.meta)
        this.cache.set(id, file.messages)
      } else {
        // 文件在但读不出来（空/坏）→ 也补一条 corrupted，让用户看得见它
        this.index.push({ id, title: '（损坏）', createdAt: nowIso(), updatedAt: nowIso(), corrupted: true })
      }
    }

    // 索引有、目录无 → 剔除
    const kept = this.index.filter((m) => onDisk.has(m.id))
    if (kept.length !== this.index.length) {
      this.index = kept
      try {
        this.writeIndex()
      } catch {
        /* 索引写失败不阻断启动 */
      }
    }
    this.index.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  /**
   * 原子写：唯一临时名 + rename。
   *
   * **没有 `rmSync`**（P1-1）：`renameSync` 本身就是覆盖语义（Node 在 Windows 用
   * MoveFileEx(REPLACE_EXISTING)），先删只会造出一个「目标文件不存在」的窗口。
   * 临时名带 pid + uuid（P1-4）：并发写者不会争同一个临时路径、不会把对方写一半的文件搬正。
   */
  private atomicWrite(file: string, data: string): void {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  private writeIndex(): void {
    this.atomicWrite(this.indexPath(), JSON.stringify(this.index, null, 2))
  }

  /** 序列化单会话为 JSONL：首行 meta，其余每行一条 message */
  private serialize(file: SessionFile): string {
    const lines = [JSON.stringify(file.meta), ...file.messages.map((m) => JSON.stringify(m))]
    return `${lines.join('\n')}\n`
  }

  private writeSession(file: SessionFile): void {
    this.cache.set(file.meta.id, file.messages)
    this.atomicWrite(join(this.dir, `${file.meta.id}${JSONL_EXT}`), this.serialize(file))
  }

  /**
   * 从磁盘读单会话（懒加载 + 缓存）。首行 meta + 其余行为消息。
   *
   * 兼容旧 `.json`（`{meta, messages}`）：读到旧格式就地迁移为 `.jsonl` 并删除旧文件。
   * 末行解析失败按「写到一半崩溃」处理 —— 丢弃该行，保留前面完整消息（不整会话报废）。
   */
  private readFile(id: string): SessionFile | null {
    const fresh = this.cache.get(id)
    if (fresh) {
      const meta = this.index.find((m) => m.id === id)
      if (meta) return { meta, messages: fresh }
    }
    const path = this.sessionFile(id)
    if (!existsSync(path)) return null
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }

    // 旧 JSON 格式：整份是 {meta, messages}
    if (path.endsWith(LEGACY_EXT)) {
      return this.readLegacy(id, text)
    }

    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return this.markCorrupted(id)
    let fileMeta: SessionMeta
    try {
      const parsed = JSON.parse(lines[0]) as SessionMeta
      if (!parsed || typeof parsed.id !== 'string') return this.markCorrupted(id)
      fileMeta = parsed
    } catch {
      return this.markCorrupted(id)
    }
    const messages: Message[] = []
    for (let i = 1; i < lines.length; i += 1) {
      try {
        messages.push(JSON.parse(lines[i]) as Message)
      } catch {
        // 末行半截（崩溃）——丢弃这一行，保留前面
        break
      }
    }
    // meta 的权威在索引；文件首行只是重建种子。索引里有就用索引的
    const authoritative = this.index.find((m) => m.id === id)
    const meta: SessionMeta = authoritative ? { ...authoritative } : fileMeta
    this.cache.set(id, messages)
    return { meta, messages }
  }

  /** 读旧 `.json` 并就地迁移为 `.jsonl` */
  private readLegacy(id: string, text: string): SessionFile | null {
    let parsed: SessionFile
    try {
      const raw = JSON.parse(text) as SessionFile
      if (!raw || typeof raw !== 'object' || !raw.meta || typeof raw.meta.id !== 'string') {
        return this.markCorrupted(id)
      }
      parsed = { meta: raw.meta, messages: Array.isArray(raw.messages) ? raw.messages : [] }
    } catch {
      return this.markCorrupted(id)
    }
    const authoritative = this.index.find((m) => m.id === id)
    const file: SessionFile = { meta: authoritative ? { ...authoritative } : parsed.meta, messages: parsed.messages }
    try {
      // 迁移：写 .jsonl，删旧 .json（只搬一次，之后走 JSONL 快路径）
      this.atomicWrite(join(this.dir, `${id}${JSONL_EXT}`), this.serialize(file))
      rmSync(join(this.dir, `${id}${LEGACY_EXT}`), { force: true })
    } catch {
      /* 迁移失败不影响本次读取（内存里已是正确内容） */
    }
    this.cache.set(id, file.messages)
    return file
  }

  /** 读单个会话全文（懒加载 + 缓存）；不存在或损坏返回 null */
  get(id: string): SessionFile | null {
    if (!id) return null
    const cached = this.cache.get(id)
    if (cached) {
      const meta = this.index.find((m) => m.id === id)
      if (meta) return { meta: { ...meta }, messages: cached }
    }
    const file = this.readFile(id)
    if (!file) return null
    return { meta: { ...file.meta }, messages: file.messages }
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

  /** 列出全部会话（索引视图；含 corrupted 标记），按 updatedAt 倒序 */
  list(): SessionMeta[] {
    return this.index.map((m) => ({ ...m }))
  }

  /** 全部会话 id（D5：给「逐个发 session.deleted」用，省掉 N 个对象拷贝） */
  ids(): Set<string> {
    return new Set(this.index.map((m) => m.id))
  }

  /** 单条元信息（不拷整份索引；事件发布用） */
  meta(id: string): SessionMeta | undefined {
    const m = this.index.find((x) => x.id === id)
    return m ? { ...m } : undefined
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
    this.index.push(meta)
    this.writeSession({ meta, messages: [] })
    this.writeIndex()
    return { ...meta }
  }

  /**
   * 重命名（不存在返回 null）。**只改索引**（P1-6 后 rename 不再重写全文）。
   * 全文首行 meta 允许陈旧 —— 索引是权威，重建种子而已。
   */
  rename(id: string, title: string): SessionMeta | null {
    const meta = this.index.find((m) => m.id === id)
    if (!meta) return null
    const next = title.trim() || meta.title
    meta.title = next
    meta.updatedAt = nowIso()
    this.writeIndex()
    return { ...meta }
  }

  /**
   * 置顶 / 取消置顶（P2-1）。**不改 `updatedAt`** —— 操作分类不是操作活动时间，
   * 否则点一下置顶，会话就跳进「今天」最顶上、行尾时间也变。
   */
  setPinned(id: string, pinned: boolean): SessionMeta | null {
    const meta = this.index.find((m) => m.id === id)
    if (!meta) return null
    if (pinned) meta.pinned = true
    else delete meta.pinned
    this.writeIndex()
    return { ...meta }
  }

  /** 归档 / 取消归档（P2-2）。与置顶同一条纪律：不改 `updatedAt` */
  setArchived(id: string, archived: boolean): SessionMeta | null {
    const meta = this.index.find((m) => m.id === id)
    if (!meta) return null
    if (archived) meta.archived = true
    else delete meta.archived
    this.writeIndex()
    return { ...meta }
  }

  /**
   * 合并式写工作区（P7 M0）：`workspace` 设项目根；`addRoot`/`removeRoot` 增删授权根。
   * **不改 `updatedAt`**（工作区是配置，不是活动时间）；`workspace` 唯一化、`workspaces` 保持加入序。
   */
  setWorkspace(
    id: string,
    patch: { workspace?: string; addRoot?: string; removeRoot?: string },
  ): SessionMeta | null {
    const meta = this.index.find((m) => m.id === id)
    if (!meta) return null
    if (typeof patch.workspace === 'string') {
      const w = patch.workspace.trim()
      if (w) meta.workspace = w
      else delete meta.workspace
    }
    let roots = meta.workspaces ? [...meta.workspaces] : []
    if (typeof patch.addRoot === 'string' && patch.addRoot.trim()) {
      const r = patch.addRoot.trim()
      if (!roots.includes(r)) roots.push(r)
    }
    if (typeof patch.removeRoot === 'string') {
      roots = roots.filter((r) => r !== patch.removeRoot)
    }
    if (roots.length > 0) meta.workspaces = roots
    else delete meta.workspaces
    this.writeIndex()
    return { ...meta }
  }

  /** 删除（不存在返回 false）：**先 unlink 文件、再改索引**（P1-2） */
  remove(id: string): boolean {
    const idx = this.index.findIndex((m) => m.id === id)
    if (idx < 0) return false
    this.cache.delete(id)
    // 先删文件：崩在索引更新前 → 对账发现「索引有条、目录无」→ 正确丢弃（不复活）
    rmSync(join(this.dir, `${id}${JSONL_EXT}`), { force: true })
    rmSync(join(this.dir, `${id}${LEGACY_EXT}`), { force: true })
    this.index.splice(idx, 1)
    this.writeIndex()
    return true
  }

  /** 清空全部（返回删除数量）：先删文件、再清索引（P1-2 同 remove） */
  clear(): number {
    const ids = this.index.map((m) => m.id)
    for (const id of ids) {
      this.cache.delete(id)
      rmSync(join(this.dir, `${id}${JSONL_EXT}`), { force: true })
      rmSync(join(this.dir, `${id}${LEGACY_EXT}`), { force: true })
    }
    this.index = []
    this.writeIndex()
    return ids.length
  }

  /**
   * 追加消息（append-only：追加一行，**不重写整个文件**，P1-6）。
   * 成功返回完整消息；会话不存在/损坏返回 null。
   */
  appendMessage(id: string, input: NewMessage): Message | null {
    const meta = this.index.find((m) => m.id === id)
    if (!meta || meta.corrupted) return null
    const message: Message = {
      id: input.id ?? newId('m'),
      role: input.role,
      createdAt: nowIso(),
      content: input.content,
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      // S4：思维链单独存（正文 content 里没有它）
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      // P7：工具轮字段（role:'tool' 的 toolCallId/toolName、role:'assistant' 的 toolCalls）
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
    }

    // 保证缓存已载入磁盘上的既有消息（新实例 / 多实例场景下 cache 可能为空，
    // 直接 push 会丢掉磁盘上已有的行）
    if (!this.cache.has(id)) this.readFile(id)

    // 保证文件存在（索引有、目录无的极端情况：用已载入的消息初始化文件）
    const path = join(this.dir, `${id}${JSONL_EXT}`)
    if (!existsSync(path)) this.writeSession({ meta: { ...meta }, messages: this.cache.get(id) ?? [] })
    appendFileSync(path, `${JSON.stringify(message)}\n`, 'utf8')

    const cached = this.cache.get(id)
    if (cached) cached.push(message)
    else this.cache.set(id, [message])

    meta.updatedAt = message.createdAt
    // 预览只取 user/assistant（tool 结果常是大段 JSON，不适合当预览）
    if (message.role === 'user' || message.role === 'assistant') {
      const preview = cleanMessagePreview(message.content)
      if (preview) meta.lastMessage = preview
    }
    this.writeIndex()
    return message
  }
}
