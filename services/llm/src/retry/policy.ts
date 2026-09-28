/**
 * 声明式 RetryPolicy（P2 §3.2 / WS-4）—— 只声明不执行（执行器 P4 落 services/llm-retry）。
 *
 * 协议唯一真相源在 @osteosome/shared；本文件保持导出兼容，避免旧 import 断链。
 */
export type { BackoffStrategy, RetryPolicy } from '@osteosome/shared'
export { DEFAULT_RETRY_POLICY } from '@osteosome/shared'
