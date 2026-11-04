/**
 * 服务清单（`service.json`）的**声明完整性**回归。
 *
 * ## 为什么值得单独一条测试
 *
 * Core 对 `bus.publish` / `bus.subscribe` 做声明校验：topic 不在本服务
 * `service.json` 的 `publishes` / `subscribes` 里，直接 `JSON-RPC error -32000`
 * 且**只有服务自己的日志里一行 WARN**。于是症状是「某条链路静默不工作」：
 *
 * 真实踩过的一次：`tools` 闸门启动后想发 `tools.list` 让执行者重播注册，
 * 但 `tools.list` 没写进它的 `publishes` → 请求被拒 → 闸门手里只有
 * 「比它晚启动」的那几个执行者 → **模型几乎没有任何工具**，
 * 而界面上一切正常（对话能聊，只是从不调用工具）。
 *
 * 所以这里钉住两类最小集合：闸门要能问、执行者要能报名。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVICES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Manifest {
  id: string
  publishes: string[]
  subscribes: string[]
}

function manifestOf(serviceId: string): Manifest {
  return JSON.parse(readFileSync(join(SERVICES, serviceId, 'service.json'), 'utf8')) as Manifest
}

describe('tools 插件的 service.json 声明', () => {
  it('闸门：既要能收注册、也要能**主动问一次**（tools.list 在 publishes 里）', () => {
    const gate = manifestOf('tools')
    // 收：执行者报名
    expect(gate.subscribes).toContain('tool.registered')
    // 问：启动后要求重播 —— 少了这条，早于闸门启动的执行者永远进不了目录
    expect(gate.publishes).toContain('tools.list')
    expect(gate.subscribes).toContain('tools.list')
    // 播：目录整份重播给 loop / 前端
    expect(gate.publishes).toContain('tools.state')
  })

  it('执行者：都要能报名（tool.registered）、回结果（tool.execute.result）、被问时重播（tools.list）', () => {
    for (const id of ['fs-tools', 'shell-tools', 'web-tools', 'misc-tools', 'skills-tools', 'mcp-tools']) {
      const manifest = manifestOf(id)
      expect(manifest.publishes, `${id} 没声明 tool.registered`).toContain('tool.registered')
      expect(manifest.publishes, `${id} 没声明 tool.execute.result`).toContain('tool.execute.result')
      // 被问时要能重播 —— 闸门靠这一问把「早于自己启动」的执行者捞回来
      expect(manifest.subscribes, `${id} 收不到 tools.list`).toContain('tools.list')
      expect(manifest.subscribes, `${id} 收不到 tool.execute`).toContain('tool.execute')
    }
  })

  it('带约束的执行者还要收 tools.state（约束/策略从闸门整份重播）', () => {
    // 只读、无约束的执行者（misc / skills）不需要它，所以不在这里断言
    for (const id of ['fs-tools', 'shell-tools', 'web-tools']) {
      expect(manifestOf(id).subscribes, `${id} 收不到 tools.state`).toContain('tools.state')
    }
  })
})
