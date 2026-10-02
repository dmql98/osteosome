/**
 * vendor wire 契约自洽性（S2 追加）—— 断言「厂商预设表声明的每个 wire 都有进程兑现」。
 *
 * ## 为什么这条测试重要
 *
 * `VendorPreset.api` 是**跨进程契约**：wire `X` 约定由服务 `llm-provider-X` 实现。
 * 表里加一行 `api: 'opencode'` 只是**声明**；真正兑现它的是一个新进程 + 一个独立插件。
 *
 * 如果只声明不兑现，坏果不是「报错」而是**静默说谎**：本进程照单全收就会注册出一个
 * 声称支持 opencode、实际发 openai 请求体的 provider —— 用户会拿到莫名其妙的 400，
 * 而且查不出根因。所以这条不变量必须在 CI 里挡住，不留到运行时。
 *
 * 它守的是「仓库自洽」——表在 `shared`、进程在 `services/`，跨包，所以只能从仓库根看。
 * 这也是它不住在某个 provider 包里的原因：它不是任何单一进程的单元测试。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  declaredWires,
  presetsForWire,
  providerServiceIdForWire,
  VENDOR_PRESETS,
  WIRE_OPENAI,
  type VendorPreset,
} from '../src/llm/vendors'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const SERVICES_DIR = join(REPO_ROOT, 'services')

describe('wire ↔ 进程 契约', () => {
  it('预设表声明的每个 wire 都有对应的 provider 服务目录', () => {
    const missing = declaredWires()
      .map((wire) => ({ wire, serviceId: providerServiceIdForWire(wire) }))
      .filter(({ serviceId }) => !existsSync(join(SERVICES_DIR, serviceId, 'service.json')))
    expect(
      missing,
      `这些 wire 声明了却没有进程兑现：${missing.map((m) => `${m.wire} → services/${m.serviceId}`).join(', ')}。` +
        `要么建这个 provider 进程（独立插件），要么别在预设表里声明这个 wire。`,
    ).toEqual([])
  })

  it('wire id → 服务 id 的映射就是 llm-provider-<wire>', () => {
    expect(providerServiceIdForWire('openai')).toBe('llm-provider-openai')
    expect(providerServiceIdForWire('opencode')).toBe('llm-provider-opencode')
  })

  it('当前只声明 openai 兼容 wire，且 12 家都归它', () => {
    expect(declaredWires()).toEqual([WIRE_OPENAI])
    expect(presetsForWire(WIRE_OPENAI)).toHaveLength(VENDOR_PRESETS.length)
  })

  it('presetsForWire 是排他的：别的 wire 拿不到 openai 的厂商', () => {
    expect(presetsForWire('opencode')).toEqual([])
  })

  it('一个都不属于任何 wire 的厂商不存在（防止漏填 api 变成孤儿）', () => {
    const orphans = VENDOR_PRESETS.filter((p) => !p.api || !p.api.trim())
    expect(orphans.map((p) => p.id)).toEqual([])
  })

  it('模拟「加了新 wire 但忘了建进程」会被抓住（证明这条断言真的会红）', () => {
    const withNewWire: VendorPreset[] = [...VENDOR_PRESETS, { ...VENDOR_PRESETS[0]!, id: 'x', api: 'ghostwire' }]
    const missing = declaredWires(withNewWire)
      .map((wire) => providerServiceIdForWire(wire))
      .filter((serviceId) => !existsSync(join(SERVICES_DIR, serviceId, 'service.json')))
    // 'ghostwire' 不该被判成有实现 —— 这就是 CI 会拦住的那个洞
    expect(missing).toEqual(['llm-provider-ghostwire'])
  })
})
