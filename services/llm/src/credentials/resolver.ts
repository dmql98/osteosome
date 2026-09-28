/**
 * 凭证引用解析（P2 §3.2 / WS-4；WS-3 迁移 `services/credentials` 能力位后本文件退场）。
 *
 * v1：只认 `env:<VAR>`（如 `env:OPENROUTER_API_KEY`）→ `process.env[...]`。
 * 预留 `core:<credentialId>`（P4 接 `core.getCredential` IPC）。
 * 解析失败 → `missing_credential`（不裸奔默认 key）。
 */
import type { StreamError } from '@osteosome/shared'

export type CredentialRef =
  | { kind: 'env'; varName: string }
  | { kind: 'core'; credentialId: string }

/** 凭证解析失败错误（带 StreamErrorCode 语义的 Error 子类；index.ts catch 按 code 判别） */
export class CredentialError extends Error {
  readonly code: StreamError['code'] = 'missing_credential'
  constructor(message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

/** `env:OPENROUTER_API_KEY` / `core:xxx` → 结构化的 CredentialRef */
export function parseCredentialRef(ref: string): CredentialRef {
  const idx = ref.indexOf(':')
  if (idx <= 0) throw new Error(`credential: invalid ref '${ref}' (expected env:<VAR> or core:<id>)`)
  const kind = ref.slice(0, idx)
  const value = ref.slice(idx + 1)
  if (kind === 'env') return { kind: 'env', varName: value }
  if (kind === 'core') return { kind: 'core', credentialId: value }
  throw new Error(`credential: unknown ref kind '${kind}' in '${ref}'`)
}

/** 解析 apiKey；失败抛 CredentialError（code = missing_credential） */
export function resolveApiKey(ref: string): string {
  const parsed = parseCredentialRef(ref)
  if (parsed.kind === 'env') {
    const value = process.env[parsed.varName]
    if (value && value.trim() !== '') return value
    throw new CredentialError(`env:${parsed.varName} is not set`)
  }
  // core: kind —— P4 才接 core 凭证 store；P2 明确报 unimplemented
  throw new CredentialError(`core credential '${parsed.credentialId}' not implemented yet (P4)`)
}
