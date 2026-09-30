/**
 * 凭证解析（P2 WS-3 纯逻辑 + P4 WS-2 接 core 能力位）—— 与 Service 装配解耦，便于单测。
 *
 * - `parseCredentialRef`：`env:<VAR>` / `core:<id>` 结构化解析（非法 → 抛错）。
 * - `resolveCredential`：解析结果 `{ ok: true, apiKey }` 或 `{ ok: false, error: StreamError }`，
 *   失败**永远带 error（missing_credential）**，不空着 apiKey、不裸奔默认 key。
 *
 * 两种 kind：
 * - `env:<VAR>` → 读 `process.env`（进程内同步解析）
 * - `core:<id>` → **P4 WS-2 新增**：经注入的 `deps.fetchCore(id)` 问 Core 凭证 store 取原值
 *   （JSON-RPC `credentials.get`，**不经总线、不落事件**；Core 不可达 → missing_credential 错误）
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

export interface ResolveDeps {
  /** `core:<id>` 取原值（注入：装配层用 service.call('credentials.get') 实现） */
  fetchCore?: (credentialId: string) => Promise<string>
}

export async function resolveCredential(ref: string, deps: ResolveDeps = {}): Promise<ResolveResult> {
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

  // core: kind —— P4 WS-2：经 Core 凭证 store 取原值（不经总线）
  if (!deps.fetchCore) {
    return {
      ok: false,
      error: { code: 'missing_credential', message: `core credential '${parsed.credentialId}' not available (no fetchCore)` },
    }
  }
  try {
    const value = await deps.fetchCore(parsed.credentialId)
    if (value && value.trim() !== '') return { ok: true, apiKey: value }
    return {
      ok: false,
      error: { code: 'missing_credential', message: `core credential '${parsed.credentialId}' has empty value` },
    }
  } catch (err) {
    return {
      ok: false,
      error: { code: 'missing_credential', message: `core credential '${parsed.credentialId}': ${String(err)}` },
    }
  }
}
