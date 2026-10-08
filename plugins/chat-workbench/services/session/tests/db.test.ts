/**
 * db 门面单测（P3-1 / M0）—— 内存库上的 exec/prepare/事务/嵌套保存点/外键。
 *
 * 这一层是后续 store 的地基：事务语义写错，store 的「列级 UPDATE / 多表写」全会静默出错。
 */
import { describe, expect, it } from 'vitest'
import { openMemoryDb } from '../src/db'

function seed(db: ReturnType<typeof openMemoryDb>): void {
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, n INTEGER)')
}

describe('db 门面', () => {
  it('exec + prepare().run/get/all 基本可用', () => {
    const db = openMemoryDb()
    seed(db)
    const ins = db.prepare<{ id: number }>('INSERT INTO t (name, n) VALUES (?, ?)')
    const r1 = ins.run('a', 1)
    const r2 = ins.run('b', 2)
    expect(r1.changes).toBe(1)
    expect(typeof r1.lastInsertRowid).toBe('number')
    expect(r2.lastInsertRowid).toBe(r1.lastInsertRowid + 1)

    const all = db.prepare<{ id: number; name: string; n: number }>('SELECT id, name, n FROM t ORDER BY id').all()
    expect(all.map((r) => r.name)).toEqual(['a', 'b'])

    const one = db.prepare<{ name: string }>('SELECT name FROM t WHERE id = ?').get(1)
    expect(one?.name).toBe('a')
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(999)).toBeUndefined()
    db.close()
  })

  it('支持 null / number / bigint / string 绑定', () => {
    const db = openMemoryDb()
    seed(db)
    db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('x', null)
    db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('big', 9_000_000_000n)
    const rows = db.prepare<{ name: string; n: number | null }>('SELECT name, n FROM t ORDER BY id').all()
    expect(rows[0].n).toBeNull()
    expect(Number(rows[1].n)).toBe(9_000_000_000)
    db.close()
  })

  it('withTransaction：成功提交，抛错整体回滚并原样重抛', () => {
    const db = openMemoryDb()
    seed(db)
    db.withTransaction(() => {
      db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('kept', 1)
    })
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM t').get()?.c).toBe(1)

    const boom = new Error('boom')
    expect(() =>
      db.withTransaction(() => {
        db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('gone', 2)
        throw boom
      }),
    ).toThrow(boom)
    // 回滚后那条不在了
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM t').get()?.c).toBe(1)
    db.close()
  })

  it('嵌套：内层保存点回滚只影响内层，外层仍提交', () => {
    const db = openMemoryDb()
    seed(db)
    db.withTransaction(() => {
      db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('outer', 1)
      try {
        db.withTransaction(() => {
          db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('inner', 2)
          throw new Error('inner fail')
        })
      } catch {
        /* 内层失败被外层吞掉，继续 */
      }
      db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('outer2', 3)
    })
    const names = db.prepare<{ name: string }>('SELECT name FROM t ORDER BY id').all().map((r) => r.name)
    expect(names).toEqual(['outer', 'outer2'])
    db.close()
  })

  it('嵌套：内层成功只 RELEASE，外层抛错则连内层一起回滚', () => {
    const db = openMemoryDb()
    seed(db)
    expect(() =>
      db.withTransaction(() => {
        db.withTransaction(() => {
          db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('inner', 1)
        })
        throw new Error('outer fail')
      }),
    ).toThrow('outer fail')
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM t').get()?.c).toBe(0)
    db.close()
  })

  it('外键：PRAGMA foreign_keys=ON 生效，ON DELETE CASCADE 级联删除', () => {
    const db = openMemoryDb()
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
    `)
    db.prepare('INSERT INTO parent (id) VALUES (?)').run('p1')
    db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'p1')
    db.prepare('DELETE FROM parent WHERE id = ?').run('p1')
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM child').get()?.c).toBe(0)
    db.close()
  })

  it('close 幂等', () => {
    const db = openMemoryDb()
    db.close()
    expect(() => db.close()).not.toThrow()
  })
})
