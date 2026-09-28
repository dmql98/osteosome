/**
 * StreamChunk —— 中立流协议（P2 §3.1，对齐 ost-开发文档.md §18）。
 *
 * 协议唯一真相源已上移 `@osteosome/shared/src/llm/`；本文件保持导出兼容。
 */
export {
  isBlockStart,
  isBlockEnd,
  isDelta,
  isFinishBlock,
  isToolArgDelta,
  validateFinishBlock,
} from '@osteosome/shared'
export type { BlockType, FinishReason, StreamChunk, Usage } from '@osteosome/shared'
