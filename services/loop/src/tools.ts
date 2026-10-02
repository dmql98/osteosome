/**
 * 工具注册表（P7 最小集）—— loop 进程内的内置工具。
 *
 * **定位（重要）**：这是 P7「最小工具循环」的种子，不是终态。终态是
 * 「工具 = 可插拔能力位 + 审批 listener + MCP」（见 `阶段追踪.md` P7 区块）。
 * 为此本文件把「工具目录（specs）」与「工具执行（execute）」分开：
 * - `specs()` 只声明 name/description/parameters → 下发给模型；
 * - `execute(name, args, signal)` 才是副作用边界 —— 将来换成跨进程调用时只改这一处。
 *
 * **安全边界（本轮刻意收窄）**：只读、不执行命令、路径锁在 `root` 内、单文件读取有上限。
 * 没有写/删/网络/进程类工具 —— 那些必须先有审批 listener（P7 后续）才允许存在。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolSpec } from '@osteosome/shared'

/** 工具执行结果（给模型看的内容 + 给 UI 看的短摘要） */
export interface ToolResult {
  ok: boolean
  /** 回填给模型的正文（role:'tool' 消息内容） */
  content: string
  /** UI 短摘要（截断后的结果或错误码） */
  summary: string
}

export interface ToolDefinition extends ToolSpec {
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}

/** 单文件读取上限（超出截断，避免把大文件灌进上下文） */
const MAX_FILE_BYTES = 64 * 1024
/** 列目录最多返回多少项 */
const MAX_DIR_ENTRIES = 200

/**
 * 路径守卫：解析到 root 之内才放行。
 * 绝对路径、`..` 逃逸、符号链接指向外部 —— 一律拒绝（返回 null 让调用方报错）。
 */
export function resolveInside(root: string, candidate: string): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  if (isAbsolute(candidate)) return null
  const base = resolve(root)
  const target = resolve(base, candidate)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  // 逐段检查，避免 `a/../../b` 这类经规范化后才暴露的越界（resolve 已处理，这里防 Windows 分隔符混用）
  if (rel.split(/[\\/]/).includes('..')) return null
  return target
}

/** 截断到上限并标注 */
function truncate(text: string, max = MAX_FILE_BYTES): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

function readTool(root: string): ToolDefinition {
  return {
    name: 'read_file',
    description: '读取工作目录内的一个文本文件，返回其内容（最多 64KB）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的文件路径' } },
      required: ['path'],
    },
    async execute(args) {
      const path = resolveInside(root, String(args.path ?? ''))
      if (!path) return `错误：路径非法或超出工作目录（${String(args.path ?? '')}）。只允许工作目录内的相对路径。`
      let stat
      try {
        stat = statSync(path)
      } catch {
        return `错误：文件不存在或不可读（${String(args.path)}）。`
      }
      if (!stat.isFile()) return `错误：不是文件（${String(args.path)}）。`
      if (stat.size > MAX_FILE_BYTES) return `错误：文件过大（${stat.size} 字节 > ${MAX_FILE_BYTES}）。`
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        return `错误：读取失败（${String(err)}）。`
      }
    },
  }
}

function listTool(root: string): ToolDefinition {
  return {
    name: 'list_dir',
    description: '列出工作目录内某个目录的条目（最多 200 项）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的目录路径，空串表示根目录' } },
      required: [],
    },
    async execute(args) {
      const raw = args.path === undefined || args.path === null ? '' : String(args.path)
      const path = raw === '' ? resolve(root) : resolveInside(root, raw)
      if (!path) return `错误：路径非法或超出工作目录（${raw}）。只允许工作目录内的相对路径。`
      let stat
      try {
        stat = statSync(path)
      } catch {
        return `错误：目录不存在（${raw || '/'}）。`
      }
      if (!stat.isDirectory()) return `错误：不是目录（${raw}）。`
      try {
        const entries = readdirSync(path, { withFileTypes: true })
          .slice(0, MAX_DIR_ENTRIES)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        const suffix = entries.length >= MAX_DIR_ENTRIES ? `\n…（仅显示前 ${MAX_DIR_ENTRIES} 项）` : ''
        return entries.length > 0 ? entries.join('\n') + suffix : '（空目录）'
      } catch (err) {
        return `错误：列目录失败（${String(err)}）。`
      }
    },
  }
}

/** 工具目录（模型可见的声明） */
export function toolSpecs(root: string): ToolSpec[] {
  return [readTool(root), listTool(root)].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }))
}

/** 工具执行（副作用边界）：未知工具返回失败结果而不是抛错（让模型能自我纠正） */
export async function executeTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = [readTool(root), listTool(root)].find((t) => t.name === name)
  if (!tool) return { ok: false, content: `错误：未知工具 ${name}。`, summary: `未知工具 ${name}` }
  try {
    const content = await tool.execute(args, signal)
    const failed = content.startsWith('错误：')
    return {
      ok: !failed,
      content: truncate(content),
      summary: truncate(content.replace(/\s+/g, ' '), 120),
    }
  } catch (err) {
    const message = `错误：工具执行异常（${String(err)}）。`
    return { ok: false, content: message, summary: message }
  }
}

/** 分隔符说明（测试与文档用：路径以 / 或 \ 均可） */
export const PATH_SEPARATORS = sep