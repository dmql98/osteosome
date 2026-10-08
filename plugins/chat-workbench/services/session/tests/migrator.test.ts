/**
 * migrator 单测（P3-1 / M1）—— 建表 / 幂等 / 索引 / 外键 / 备份 / 失败回滚 / 幂等加列。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, openMemoryDb, type Db } from '../src/db'
import { addColumnIfMissing, currentVersion, LATEST_VERSION, migrate, MIGRATIONS } from '../src/migrator'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-mig-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const tableNames = (db: Db): string[] =>
  db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)

const indexNames = (db: Db, table: string): string[] =>
  db.prepare<{ name: string }>(`PRAGMA index_list(${table})`).all().map((r) => r.name)

describe('migrator', () => {
  it('首次 migrate：建两表 + _migrations，返回 LATEST_VERSION', () => {
    const db = openMemoryDb()
    expect(currentVersion(db)).toBe(0)
    expect(migrate(db)).toBe(LATEST_VERSION)
    const names = tableNames(db)
    expect(names).toContain('sessions')
    expect(names).toContain('messages')
    expect(names).toContain('_migrations')
    db.close()
  })

  it('幂等：重复 migrate 不再插入、不抛', () => {
    const db = openMemoryDb()
    migrate(db)
    expect(migrate(db)).toBe(LATEST_VERSION)
    const rows = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM _migrations').get()
    expect(rows?.c).toBe(MIGRATIONS.length)
    db.close()
  })

  it('两表字段齐全（含 seq / tool_calls / workspaces）', () => {
    const db = openMemoryDb()
    migrate(db)
    const sCols = db.prepare<{ name: string }>('PRAGMA table_info(sessions)').all().map((r) => r.name)
    for (const c of ['id', 'title', 'created_at', 'updated_at', 'pinned', 'archived', 'parent_id', 'last_message', 'workspace', 'workspaces', 'corrupted']) {
      expect(sCols).toContain(c)
    }
    const mCols = db.prepare<{ name: string }>('PRAGMA table_info(messages)').all().map((r) => r.name)
    for (const c of ['id', 'session_id', 'seq', 'role', 'created_at', 'content', 'finish_reason', 'prompt_tokens', 'completion_tokens', 'reasoning', 'tool_call_id', 'tool_name', 'tool_calls']) {
      expect(mCols).toContain(c)
    }
    db.close()
  })

  it('四个索引都在', () => {
    const db = openMemoryDb()
    migrate(db)
    expect(indexNames(db, 'sessions')).toEqual(
      expect.arrayContaining(['idx_sessions_updated_at', 'idx_sessions_pinned', 'idx_sessions_archived']),
    )
    expect(indexNames(db, 'messages')).toContain('idx_messages_session_seq')
    db.close()
  })

  it('外键级联：删会话带走其消息', () => {
    const db = openMemoryDb()
    migrate(db)
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)').run('s1', 't', 'now', 'now')
    db.prepare('INSERT INTO messages (id, session_id, seq, role, created_at, content) VALUES (?,?,?,?,?,?)').run(
      'm1',
      's1',
      1,
      'user',
      'now',
      'hi',
    )
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM messages').get()?.c).toBe(0)
    db.close()
  })

  it('备份：已有库再迁移时生成 sessions.db.pre-<ver>-*，且不删', () => {
    const dbPath = join(dir, 'sessions.db')
    const db1 = openDb(dbPath)
    migrate(db1, { dbPath, migrations: MIGRATIONS })
    expect(migrate(db1, { dbPath, migrations: MIGRATIONS })).toBe(1)

    // 注入一个 v2，模拟后续结构变更
    const m2 = { version: 2, name: 'add-noise', up: (d: Db) => addColumnIfMissing(d, 'sessions', 'noise', 'TEXT') }
    expect(migrate(db1, { dbPath, migrations: [...MIGRATIONS, m2] })).toBe(2)
    db1.close()

    const backups = readdirSync(dir).filter((f) => /^sessions\.db\.pre-2-/.test(f))
    expect(backups).toHaveLength(1)
    // 备份未删
    expect(readdirSync(dir).some((f) => f === backups[0])).toBe(true)
  })

  it('失败回滚：迁移抛错 → 版本不变、半成品表不存在', () => {
    const db = openMemoryDb()
    const bad = [
      {
        version: 1,
        name: 'bad',
        up: (d: Db) => {
          d.exec('CREATE TABLE t1 (x INTEGER)')
          throw new Error('nope')
        },
      },
    ]
    expect(() => migrate(db, { migrations: bad })).toThrow('nope')
    expect(currentVersion(db)).toBe(0)
    expect(tableNames(db)).not.toContain('t1')
    db.close()
  })

  it('addColumnIfMissing：不存在才加，重复调用幂等', () => {
    const db = openMemoryDb()
    migrate(db)
    addColumnIfMissing(db, 'sessions', 'extra', 'TEXT')
    addColumnIfMissing(db, 'sessions', 'extra', 'TEXT')
    const cols = db.prepare<{ name: string }>('PRAGMA table_info(sessions)').all().map((r) => r.name)
    expect(cols.filter((c) => c === 'extra')).toHaveLength(1)
    db.close()
  })
})
