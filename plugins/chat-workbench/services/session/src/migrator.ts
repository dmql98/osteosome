/**
 * Schema 迁移引擎（P3-1 / 阶段 F M1）。
 *
 * ## 为什么要有版本表
 *
 * JSONL 时代「结构坏了只能手改 JSON」（D2 那一类问题）。SQLite 下同一类问题的正确解法是
 * 「结构变更写成 migration」：`_migrations` 记录已应用版本，每步在 `BEGIN IMMEDIATE` 里
 * 原子执行 —— 失败整体回滚，不会留下「加了一半列」的库。
 *
 * ## 备份是硬要求
 *
 * 换存储不可逆。每步**迁移前**把库文件复制一份 `sessions.db.pre-<目标版本>-<ts>`，
 * **备份不删**。首次建库（`current === 0`、库里还没有任何东西）不需要备份。
 *
 * ## 幂等加列
 *
 * 后续 migration 会不断加列。手写 `ALTER TABLE ADD COLUMN` 一旦重复执行就抛
 * 「duplicate column」。`addColumnIfMissing` 先查 `PRAGMA table_info`，是后续 migration 的标准动作。
 */
import { copyFileSync, existsSync } from 'node:fs'
import { type Db } from './db'

export interface Migration {
  version: number
  name: string
  up: (db: Db) => void
}

/** 两表 + 四索引（优化计划 §6.6；`seq` 偏差见详细计划 §4.1）。 */
const INITIAL_SCHEMA = `
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  parent_id    TEXT,
  last_message TEXT,
  workspace    TEXT,
  workspaces   TEXT,
  corrupted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  content           TEXT NOT NULL,
  finish_reason     TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  reasoning         TEXT,
  tool_call_id      TEXT,
  tool_name         TEXT,
  tool_calls        TEXT
);

CREATE INDEX idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_pinned     ON sessions(pinned);
CREATE INDEX idx_sessions_archived   ON sessions(archived);
CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);
`

/** 全部 migration，按 version 升序。 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    up: (db) => db.exec(INITIAL_SCHEMA),
  },
]

/** 当前代码期望的最高 schema 版本。 */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

/** 幂等加列：不存在才 `ALTER TABLE`。 */
export function addColumnIfMissing(db: Db, table: string, column: string, decl: string): void {
  const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all()
  if (rows.some((r) => r.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}

/** 已应用的 schema 版本（无 `_migrations` 表 → 0）。 */
export function currentVersion(db: Db): number {
  db.exec(MIGRATIONS_TABLE)
  const row = db.prepare<{ v: number | null }>('SELECT MAX(version) AS v FROM _migrations').get()
  return Number(row?.v ?? 0)
}

export interface MigrateOptions {
  /** 文件库路径；`:memory:` 或省略则不备份。 */
  dbPath?: string
  /** 覆盖 migration 列表（测试用）。 */
  migrations?: Migration[]
  /** 可注入的时钟（备份文件名与 `applied_at`）。 */
  now?: () => Date
}

/**
 * 应用所有未执行的 migration，返回最终版本。
 *
 * 每步前若 `current > 0` 且是文件库 → 备份库文件（checkpoint 后复制，保证 -wal 已落盘）。
 */
export function migrate(db: Db, options: MigrateOptions = {}): number {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version)
  const now = options.now ?? (() => new Date())
  const dbPath = options.dbPath
  const isFile = !!dbPath && dbPath !== ':memory:'

  let current = currentVersion(db)
  const pending = migrations.filter((m) => m.version > current)
  if (pending.length === 0) return current

  const targetVersion = pending[pending.length - 1].version
  // 首次建库（current === 0）无需备份 —— 没有旧数据可保
  if (isFile && current > 0 && existsSync(dbPath!)) {
    backup(db, dbPath!, targetVersion, now())
  }

  for (const m of pending) {
    db.withTransaction(() => {
      m.up(db)
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now().toISOString(),
      )
    })
    current = m.version
  }
  return current
}

/** 备份库文件：先 checkpoint（把 -wal 落进主文件），再复制。文件名带目标版本 + 时间戳。 */
function backup(db: Db, dbPath: string, targetVersion: number, at: Date): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* 内存/journal 模式没有 WAL，忽略 */
  }
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  copyFileSync(dbPath, `${dbPath}.pre-${targetVersion}-${stamp}`)
}
