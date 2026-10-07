/**
 * 技能存储（P6 WS-1）—— 用户自建 SKILL.md + 机器级开关 `skills.json`。
 *
 * ## 布局（`service.dataDir` = `userData/plugin/skills/`）
 *
 * ```
 * custom/<name>/SKILL.md   ← 用户自建技能（**skills 服务是唯一写者**）
 * skills.json              ← 机器级「本机可用」开关（key = ownerPluginId::name）
 * ```
 *
 * 插件自带的技能**不在这里** —— 那是各插件自己的服务读完再 `publish skill.registered` 交上来的
 * （`plugins.readFile` 只限自己插件目录）。本服务只当**收集方**。
 *
 * ## 为什么「本机可用」与「角色绑定」是两处
 *
 * 本机可用是**预算闸门**（索引片段 8 KB / 20 条，所有角色绑定的并集照样能撑爆）+
 * 「这台机器不要这个能力」；角色绑定是「这个角色要不要」。两者 AND。
 * 关掉本机可用**不删角色绑定**（与卸载不回溯历史同一条纪律），重开即恢复。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertSafeSkillName, parseSkillMd, type SkillIndexEntry } from '@osteosome/shared'

const CUSTOM_DIR = 'custom'
const ENABLED_FILE = 'skills.json'

interface StoredEnabled {
  version: number
  enabled: Record<string, boolean>
}

export class SkillStore {
  private readonly dir: string
  private readonly customDir: string
  private readonly enabledFile: string
  private enabled: Record<string, boolean> = {}

  constructor(dataDir: string) {
    this.dir = dataDir
    this.customDir = join(dataDir, CUSTOM_DIR)
    this.enabledFile = join(dataDir, ENABLED_FILE)
    mkdirSync(this.customDir, { recursive: true })
    this.loadEnabled()
  }

  private loadEnabled(): void {
    if (!existsSync(this.enabledFile)) {
      this.enabled = {}
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.enabledFile, 'utf8')) as Partial<StoredEnabled>
      this.enabled = parsed && typeof parsed.enabled === 'object' && parsed.enabled ? { ...parsed.enabled } : {}
    } catch {
      this.enabled = {}
    }
  }

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

  private persistEnabled(): void {
    this.atomicWrite(this.enabledFile, `${JSON.stringify({ version: 1, enabled: this.enabled } satisfies StoredEnabled, null, 2)}\n`)
  }

  /** 本机可用开关（缺省 true） */
  isEnabled(ownerPluginId: string, name: string): boolean {
    return this.enabled[`${ownerPluginId}::${name}`] ?? true
  }

  setEnabled(ownerPluginId: string, name: string, value: boolean): void {
    this.enabled[`${ownerPluginId}::${name}`] = value
    this.persistEnabled()
  }

  /** 扫 `custom/` 目录，解析每个 SKILL.md（逐条容错，坏一个不拖垮其余） */
  customSkills(): SkillIndexEntry[] {
    const out: SkillIndexEntry[] = []
    if (!existsSync(this.customDir)) return out
    for (const entry of readdirSync(this.customDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(this.customDir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        const pkg = parseSkillMd(readFileSync(file, 'utf8'), entry.name)
        out.push({ ownerPluginId: 'user', name: pkg.name, description: pkg.description, source: 'custom', enabled: true })
      } catch {
        // 坏档跳过（不崩服务、不吞其余）
      }
    }
    return out
  }

  /** 读一个自建技能的正文（前端编辑器用）；不存在返回 null */
  readCustom(name: string): string | null {
    if (!assertSafeSkillName(name)) return null
    const file = join(this.customDir, name, 'SKILL.md')
    if (!existsSync(file)) return null
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  /** 写/新建一个自建技能 */
  writeCustom(name: string, content: string): void {
    if (!assertSafeSkillName(name)) throw new Error(`invalid skill name '${name}'`)
    const dir = join(this.customDir, name)
    mkdirSync(dir, { recursive: true })
    this.atomicWrite(join(dir, 'SKILL.md'), content)
  }

  /** 删除一个自建技能（不可逆；界面只提供停用，见技能设计稿 §2） */
  removeCustom(name: string): boolean {
    if (!assertSafeSkillName(name)) return false
    const dir = join(this.customDir, name)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    return true
  }

  get root(): string {
    return this.dir
  }
}
