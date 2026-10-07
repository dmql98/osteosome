/** fs-tools 的工具声明（`tools.json` 的 TS 形式；构建时打进单文件，避免运行期读文件） */
import type { ConstraintField } from '@osteosome/shared'

export interface ToolDecl {
  name: string
  risk: 'read' | 'write' | 'net' | 'proc'
  description: string
  parameters: Record<string, unknown>
  constraintFields?: ConstraintField[]
}

export const FS_TOOLS: ToolDecl[] = [
  {
    name: 'read',
    risk: 'read',
    description: '读取工作区内一个文本文件（支持 offset/limit 分页）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['path'],
    },
    constraintFields: [
      { key: 'allowed_paths', label: '允许路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-allow' },
      { key: 'denied_paths', label: '禁止路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-deny' },
    ],
  },
  {
    name: 'glob',
    risk: 'read',
    description: '按 glob 列出工作区内的文件',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    constraintFields: [
      { key: 'allowed_paths', label: '允许路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-allow' },
    ],
  },
  {
    name: 'grep',
    risk: 'read',
    description: '在工作区内按正则搜索文件内容',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' }, max_rows: { type: 'number' } },
      required: ['pattern'],
    },
    constraintFields: [
      { key: 'max_rows', label: '最大行数', type: 'string', validateArg: 'max_rows', validateRule: 'max-number' },
    ],
  },
  {
    name: 'write',
    risk: 'write',
    description: '写入（覆盖）工作区内的一个文件',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    constraintFields: [
      { key: 'allowed_paths', label: '允许路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-allow' },
      { key: 'denied_paths', label: '禁止路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-deny' },
      { key: 'max_file_size', label: '单文件大小', type: 'string', validateArg: 'content', validateRule: 'bytes-max' },
    ],
  },
  {
    name: 'edit',
    risk: 'write',
    description: '对工作区内一个文件做单处/多处字符串替换',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'find', 'replace'],
    },
    constraintFields: [
      { key: 'allowed_paths', label: '允许路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-allow' },
      { key: 'denied_paths', label: '禁止路径', type: 'string-list', validateArg: 'path', validateRule: 'glob-deny' },
    ],
  },
]
