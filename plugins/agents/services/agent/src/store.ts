/**
 * 角色存储（P5 WS-1）—— `userData/plugin/agents/characters.json` 的唯一读写者。
 *
 * ## 布局
 *
 * ```
 * <dataDir>/characters.json   ← CharacterBrief[]（缺席 = 还没有角色，合法）
 * ```
 *
 * `service.dataDir` 由握手回填、指向 `pluginDataDir(dataDir, 'agents')`，所以直接
 * `join(dataDir, 'characters.json')`。**必须在 `service.start()` 之后才建 store** ——
 * 之前 `dataDir` 恒为 `''`，退到相对路径就是会话服务那次「487 条写进 dist/」的同款事故。
 *
 * ## 原子写
 *
 * 临时文件（pid+uuid 唯一名）+ rename 覆盖，不留「删旧到 rename 之间」的空窗
 * （同 session store 的 P1-1 教训）。
 *
 * ## 缺失是合法的
 *
 * 文件不存在 → 空数组（用户还没建角色）；解析失败 → 逐条报错后能用的照用，
 * 不整份拒、不崩服务（同 `parseSkinCatalog`）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  mergeCharacterPatch,
  parseCharacters,
  sortCharacters,
  type AgentStatePatch,
  type CharacterBrief,
} from '@osteosome/shared'

const FILE_NAME = 'characters.json'

export class CharacterStore {
  private readonly file: string
  private characters: CharacterBrief[] = []
  private readonly errors: string[] = []

  constructor(dataDir: string) {
    this.file = join(dataDir, FILE_NAME)
    mkdirSync(dirname(this.file), { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.characters = []
      return
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      const { characters, errors } = parseCharacters(raw)
      this.characters = sortCharacters(characters)
      this.errors.push(...errors)
    } catch (err) {
      // 整份坏 → 空数组（不崩服务；下一次写入会重建文件）
      this.errors.push(`characters.json parse failed: ${String(err)}`)
      this.characters = []
    }
  }

  private atomicWrite(data: string): void {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  private persist(): void {
    this.atomicWrite(`${JSON.stringify(this.characters, null, 2)}\n`)
  }

  /** 读盘期的问题（供日志）；只读一次，随后清空 */
  takeErrors(): string[] {
    const e = [...this.errors]
    this.errors.length = 0
    return e
  }

  list(): CharacterBrief[] {
    return this.characters.map((c) => ({ ...c }))
  }

  get(id: string): CharacterBrief | undefined {
    const c = this.characters.find((x) => x.id === id)
    return c ? { ...c } : undefined
  }

  /**
   * 合并式写（`agent.state.set`）。
   * - `removed` → 按 id 删（不存在返回 false，不算错）
   * - `character` → upsert（按 id 合并）；返回改后的条目
   * 返回 `{ changed }` —— 没实际改动就不落盘、不重播。
   */
  apply(patch: AgentStatePatch): { changed: boolean; character?: CharacterBrief; removed?: string } {
    if (patch.removed) {
      const before = this.characters.length
      this.characters = this.characters.filter((c) => c.id !== patch.removed)
      if (this.characters.length === before) return { changed: false }
      this.persist()
      return { changed: true, removed: patch.removed }
    }
    if (patch.character && typeof patch.character.id === 'string' && patch.character.id.trim()) {
      const id = patch.character.id
      const current = this.characters.find((c) => c.id === id)
      const next = mergeCharacterPatch(current, patch.character)
      const at = this.characters.findIndex((c) => c.id === id)
      if (at >= 0) this.characters[at] = next
      else this.characters.push(next)
      this.characters = sortCharacters(this.characters)
      this.persist()
      return { changed: true, character: next }
    }
    return { changed: false }
  }
}
