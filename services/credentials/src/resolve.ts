/**
 * 凭证解析纯逻辑（P2 WS-3）—— 与 Service 装配解耦，便于单测。
 *
 * - `parseCredentialRef`：`env:<VAR>` / `core:<id>` 结构化解析（非法 → 抛错）。
 * - `resolveCredential`：解析结果 `{ ok: true, apiKey }` 或 `{ ok: false, error: StreamError }`，
 *   失败**永远带 error（missing_credential）**，不空着 apiKey、不裸奔默认 key。
 */
import type { StreamError } from '@osteosome/shared'

export type ParsedCredentialRef =
  | { kind: 'env'; varName: string }
  | { kind: 'core'; credentialId: string }

export function parseCredentialRef(ref: string): ParsedCredentialRef {
  const idx = ref.indexOf(':')
  if (idx <= 0) throw new Error(`credential: invalid ref '${ref}' (expected env:<VAR> or core:<id>)`)
  const kind = ref.slice(0, idx)
  const value = ref.slice(idx + 1)
  if (kind === 'env') return { kind: 'env', varName: value }
  if (kind === 'core') return { kind: 'core', credentialId: value }
  throw new Error(`credential: unknown ref kind '${kind}' in '${ref}'`)
}

export type ResolveResult =
  | { ok: true; apiKey: string }
  | { ok: false; error: StreamError }

export function resolveCredential(ref: string): ResolveResult {
  let parsed: ParsedCredentialRef
  try {
    parsed = parseCredentialRef(ref)
  } catch (err) {
    return { ok: false, error: { code: 'missing_credential', message: String(err) } }
  }

  if (parsed.kind === 'env') {
    const value = process.env[parsed.varName]
    if (value && value.trim() !== '') return { ok: true, apiKey: value }
    return {
      ok: false,
      error: { code: 'missing_credential', message: `env:${parsed.varName} is not set` },
    }
  }

  // core: kind —— P4 才接凭证 store；P2 明确报 unimplemented
  return {
    ok: false,
    error: { code: 'missing_credential', message: `core credential '${parsed.credentialId}' not implemented yet (P4)` },
  }
}
