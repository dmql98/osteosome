import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 回归：dev 代理少配 `/plugins` 会让插件 UI 的 iframe 落到 Vite 的 SPA fallback。
 *
 * 症状是「加入窗口」之后每个盒子里套一个完整的宿主工作台 —— iframe 拿到的是
 * Vite 自己的 index.html（`/@vite/client` + `/src/main.ts`），而不是
 * `/plugins/<id>/ui/index.html`。Core 那一侧是对的，问题只在 dev server 的转发表。
 *
 * 为什么不直接 import 配置对象：`vite.config.ts` 会拉起 esbuild，在 jsdom 环境里
 * 直接炸 `new TextEncoder().encode("") instanceof Uint8Array`，所以只读源码断言转发表。
 */
// cwd 随运行方式变（client 包内跑是 client/，仓库根跑是根），两个候选都试一遍。
// 不用 import.meta.url：jsdom 下它不是 file: scheme，fileURLToPath 会抛。
const configFile = ['vite.config.ts', 'client/vite.config.ts']
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate))

expect(configFile, '找不到 client/vite.config.ts').toBeTruthy()
const source = readFileSync(configFile as string, 'utf8')

/** `server:` 段里的转发表：路径前缀 → 绑定的 handler 名 */
function proxyTable(): Record<string, string> {
  const start = source.indexOf('server: {')
  const end = source.indexOf('build: {')
  expect(start, 'vite.config.ts 里找不到 server 段').toBeGreaterThan(-1)
  expect(end, 'vite.config.ts 里找不到 build 段').toBeGreaterThan(-1)
  const block = source.slice(start, end)
  return Object.fromEntries(
    [...block.matchAll(/^\s*'([^']+)':\s*([A-Za-z_$][\w$]*),/gm)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  )
}

describe('vite dev proxy', () => {
  it('转发 /plugins 到 Core', () => {
    expect(Object.keys(proxyTable())).toContain('/plugins')
  })

  it('/plugins 与 /api 共用同一套 Core Origin 判定', () => {
    const table = proxyTable()
    expect(table['/plugins']).toBeTruthy()
    expect(table['/plugins']).toBe(table['/api'])
  })
})
