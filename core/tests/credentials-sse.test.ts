/**
 * /api/credentials 集成测试（P4 WS-1 子绿灯）—— 起真 Core，验证前端通道只回掩码。
 * 威胁模型红线：原值永不经 SSE / 前端（P4 §0.1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore } from '../src/main'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')


// ── /api/credentials SSE 通道（P4 WS-1 子绿灯：掩码回包 + 原值不出前端）──
describe('/api/credentials（SSE 掩码通道）', () => {
  let core: Awaited<ReturnType<typeof startCore>> | undefined
  let dataDir = ''

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ost-cred-sse-'))
    core = await startCore({
      argv: [],
      config: { servicesDir: path.join(REPO_ROOT, 'services'), dataDir, distDir: join(dataDir, 'dist'), port: 0 },
      manager: { backoffBaseMs: 50, stopGraceMs: 1000 },
      bridge: { heartbeatMs: 0, zombieMs: 0 },
    })
  }, 30_000)

  afterAll(async () => {
    await core?.stop().catch(() => undefined)
    core = undefined
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  }, 15_000)

  const base = (): string => `http://127.0.0.1:${core!.port}`

  it('PUT → 掩码回包（无原值）；GET → 掩码列表（原值永不出）', async () => {
    const put = await fetch(`${base()}/api/credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My key', provider: 'deepseek', value: 'sk-frontend-secret-9999' }),
    })
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as { credential: { id: string; masked: string } }
    // PUT 回包是掩码
    expect(putBody.credential.masked).not.toBe('sk-frontend-secret-9999')
    expect(JSON.stringify(putBody)).not.toContain('sk-frontend-secret-9999')

    const get = await fetch(`${base()}/api/credentials`)
    expect(get.status).toBe(200)
    const getBody = await get.text()
    // GET 列表绝不含原值
    expect(getBody).not.toContain('sk-frontend-secret-9999')
    expect(getBody).toContain('masked')
  })

  it('DELETE → 移除', async () => {
    const put = await fetch(`${base()}/api/credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', provider: 'p', value: 'v-del' }),
    })
    const { credential } = (await put.json()) as { credential: { id: string } }
    const del = await fetch(`${base()}/api/credentials?id=${encodeURIComponent(credential.id)}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })
})
