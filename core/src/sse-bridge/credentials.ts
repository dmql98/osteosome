/**
 * /api/credentials（P4 WS-1）—— 前端凭证管理通道。
 *
 * 威胁模型红线（P4 §0.1 / §3.1）：
 * - **GET 永远只回掩码**（masked），**前端永不见原值**；
 * - 原值只经 **JSON-RPC `credentials.get`（仅服务进程）** 出去，不经本路由；
 * - 事件 `credential.saved/deleted` 只带 `{ id, name, provider }`。
 *
 * GET    → 掩码列表 `{ credentials: MaskedCredential[] }`
 * PUT    → 写入 `{ id?, name, provider, value }` → 掩码回包
 * DELETE → 删除（`?id=` 查询参数）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialApi } from '../credentials/api'
import { CredentialStoreError } from '../credentials/api'
import { readJsonBody, sendJson } from './util'

export async function handleCredentials(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  api: CredentialApi,
): Promise<void> {
  try {
    if (req.method === 'GET') {
      if (api.isCorrupted()) {
        sendJson(res, 500, { error: 'credentials store is corrupted' })
        return
      }
      sendJson(res, 200, { credentials: api.list() })
      return
    }

    if (req.method === 'PUT') {
      if (api.isCorrupted()) {
        sendJson(res, 500, { error: 'credentials store is corrupted' })
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { error: `invalid JSON body: ${String(err)}` })
        return
      }
      const b = body as { id?: string; name?: string; provider?: string; value?: string }
      if (!b || typeof b !== 'object' || typeof b.value !== 'string' || !b.value) {
        sendJson(res, 400, { error: 'body requires value (string)' })
        return
      }
      const masked = api.set({
        ...(typeof b.id === 'string' && b.id ? { id: b.id } : {}),
        name: typeof b.name === 'string' ? b.name : '',
        provider: typeof b.provider === 'string' ? b.provider : '',
        value: b.value,
      })
      // 回包是掩码——原值不出 Core
      sendJson(res, 200, { ok: true, credential: masked })
      return
    }

    if (req.method === 'DELETE') {
      if (api.isCorrupted()) {
        sendJson(res, 500, { error: 'credentials store is corrupted' })
        return
      }
      const id = url.searchParams.get('id') ?? ''
      if (!id) {
        sendJson(res, 400, { error: 'id query param required' })
        return
      }
      const ok = api.delete(id)
      sendJson(res, ok ? 200 : 404, { ok })
      return
    }

    sendJson(res, 405, { error: 'method not allowed' })
  } catch (err) {
    if (err instanceof CredentialStoreError) {
      sendJson(res, err.reason === 'not_found' ? 404 : 500, { error: err.message })
      return
    }
    throw err
  }
}
