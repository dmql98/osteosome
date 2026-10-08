/**
 * SQLite 门面（P3-1 / 阶段 F M0）—— 把 `node:sqlite` 收进一个**刻意小**的接口。
 *
 * ## 为什么要有这层
 *
 * 指南允许「破坏性修改所有 store 调用点，不要求模仿 better-sqlite3 的完整 API」。
 * 门面越小，将来换驱动（虽然红线是不换）或加审计点的成本越低。这里只暴露五个东西：
 * `exec` / `prepare().run|get|all` / `withTransaction` / `close`。
 *
 * ## 为什么只用 `node:sqlite`
 *
 * 零原生依赖，绕开 better-sqlite3 的 ABI / 打包那一整套（见优化计划 §6.3）。
 * 它是实验性模块：v22.5 引入，**v22.13 / v23.4 起才不再需要 `--experimental-sqlite`**，
 * 故 `engines.node` 与本阶段一并上调到 `>=22.13.0`。
 *
 * ## 参数与返回值
 *
 * `node:sqlite` **绑不了 JS boolean / undefined**（会直接抛）。门面把可绑类型收窄成
 * `SqlParam`，迫使调用点在写库前自己转成 `0/1`（见 store 的 `toDbFlags`）。
 * `run()` 的 `changes` / `lastInsertRowid` 按 `number` 归一（SQLite 可能给 bigint，
 * 我们库规模远够不到 2^53，统一收敛以免调用点到处 `Number(...)`）。
 */
import { DatabaseSync } from 'node:sqlite'

/** 可绑定的 SQL 参数。**故意不含 boolean / undefined** —— node:sqlite 对它们会抛。 */
export type SqlParam = null | number | bigint | string | Uint8Array

/** `run()` 的结果，已归一成普通对象。 */
export interface RunResult {
  changes: number
  lastInsertRowid: number
}

/** 预编译语句。行形状由泛型 `Row` 决定（默认宽松对象）。 */
export interface DbStatement<Row = Record<string, unknown>> {
  run(...params: SqlParam[]): RunResult
  get(...params: SqlParam[]): Row | undefined
  all(...params: SqlParam[]): Row[]
}

export interface Db {
  /** 执行一段（可含多条）SQL；不走参数绑定。 */
  exec(sql: string): void
  /** 预编译一条语句。 */
  prepare<Row = Record<string, unknown>>(sql: string): DbStatement<Row>
  /**
   * 事务包裹。最外层 `BEGIN IMMEDIATE`，嵌套层 `SAVEPOINT`。
   * 回调抛错 → 整层回滚并原样重抛（不吞）。
   */
  withTransaction<T>(fn: () => T): T
  /** 关闭连接。重复调用安全。 */
  close(): void
}

/** node:sqlite 的 `run` 可能回 bigint；统一成 number（库规模远小于 2^53）。 */
function normalizeRun(raw: unknown): RunResult {
  const r = raw as { changes?: number | bigint; lastInsertRowid?: number | bigint } | undefined
  return {
    changes: Number(r?.changes ?? 0),
    lastInsertRowid: Number(r?.lastInsertRowid ?? 0),
  }
}

/**
 * 打开（或新建）一个库并返回门面。
 *
 * @param path 文件路径，或 `':memory:'`（测试用）。
 */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path)

  // 外键约束默认关闭 —— 必须显式打开，`ON DELETE CASCADE` 才会生效。
  db.exec('PRAGMA foreign_keys = ON')
  // 并发写者（同进程内多 prepared/事务）短暂争锁时等一等，而不是立刻 SQLITE_BUSY。
  db.exec('PRAGMA busy_timeout = 5000')
  // 文件库用 WAL（读写并发更好）；内存库该 PRAGMA 是无副作用的 no-op。
  db.exec('PRAGMA journal_mode = WAL')

  let depth = 0
  let closed = false

  return {
    exec(sql: string): void {
      db.exec(sql)
    },
    prepare<Row = Record<string, unknown>>(sql: string): DbStatement<Row> {
      const stmt = db.prepare(sql)
      return {
        run: (...params: SqlParam[]): RunResult => normalizeRun(stmt.run(...params)),
        get: (...params: SqlParam[]): Row | undefined => stmt.get(...params) as Row | undefined,
        all: (...params: SqlParam[]): Row[] => stmt.all(...params) as Row[],
      }
    },
    withTransaction<T>(fn: () => T): T {
      const top = depth === 0
      const savepoint = `sp_${depth}`
      db.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
      depth += 1
      try {
        const out = fn()
        depth -= 1
        db.exec(top ? 'COMMIT' : `RELEASE ${savepoint}`)
        return out
      } catch (err) {
        depth -= 1
        try {
          db.exec(top ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
        } catch {
          /* 回滚自身失败时不遮盖原始错误 */
        }
        throw err
      }
    },
    close(): void {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

/** 内存库（测试与短生命周期用）。 */
export function openMemoryDb(): Db {
  return openDb(':memory:')
}
