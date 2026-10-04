/**
 * vendor wire 契约自洽性 —— 断言「catalog.json 声明的每个 wire 都有进程兑现」。
 *
 * ## 为什么这条测试重要
 *
 * `VendorPreset.api` 是**跨进程契约**：wire `X` 约定由服务 `llm-provider-X` 实现。
 * 表里加一行 `api: 'opencode'` 只是**声明**；真正兑现它的是一个新进程 + 一个独立插件。
 *
 * 如果只声明不兑现，坏果不是「报错」而是**静默说谎**：那个进程照单全收就会注册出一个
 * 声称支持 opencode、实际发 openai 请求体的 provider —— 用户会拿到莫名其妙的 400，
 * 而且查不出根因。所以这条不变量必须在 CI 里挡住，不留到运行时。
 *
 * 它守的是「仓库自洽」——数据在 `plugins/models/`、进程在 `plugins/<plugin>/services/`，
 * 跨包，所以只能从仓库根看。这也是它不住在某个 provider 包里的原因：
 * 它不是任何单一进程的单元测试。
 *
 * ## P5：数据源从代码变成文件
 *
 * 原来读的是 `shared` 里的 `VENDOR_PRESETS` 常量。现在读
 * `plugins/models/catalog.json` —— 于是这条测试顺带成了**那份数据的第一道校验**：
 * 手写 JSON 少一个逗号、id 打错一个字母，在这里就红，而不是等到某个厂商
 * 在用户界面上神秘地不出现。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  declaredWires,
  parseVendorCatalog,
  presetsForWire,
  providerServiceIdForWire,
  WIRE_OPENAI,
  type VendorPreset,
} from '../src/llm/vendors'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const PLUGINS_DIR = join(REPO_ROOT, 'plugins')
const CATALOG_PATH = join(REPO_ROOT, 'plugins', 'models', 'catalog.json')

/** 读插件自带的那份目录（读一次，多个用例共用；文件变了重跑测试就是） */
function loadCatalog(): { vendors: VendorPreset[]; errors: string[] } {
  return parseVendorCatalog(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
}

const catalog = loadCatalog()

/**
 * 某个服务 id 在**仓库里**有没有兑现 —— P1 之后是两级目录
 * （`plugins/〈插件〉/services/〈id〉/service.json`），所以要扫插件目录，不能只看平铺的 services/。
 */
function serviceExists(serviceId: string): boolean {
  for (const plugin of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    if (existsSync(join(PLUGINS_DIR, plugin.name, 'services', serviceId, 'service.json'))) return true
  }
  return false
}

describe('catalog.json 本身', () => {
  it('能被解析且**逐条无错**（手写 JSON 的第一道关）', () => {
    expect(catalog.errors).toEqual([])
    expect(catalog.vendors.length).toBeGreaterThan(0)
  })

  it('id 唯一（重复会被后面的静默覆盖，用户看到的是「设了没生效」）', () => {
    const ids = catalog.vendors.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('有凭证的厂商必须写清 env 名，免凭证的必须是空串（不是缺字段）', () => {
    for (const v of catalog.vendors) {
      const local = v.baseUrl.includes('127.0.0.1') || v.baseUrl.includes('localhost')
      if (local) {
        expect(v.credentialEnv, `${v.id} 是本地端点，credentialEnv 应为空串`).toBe('')
      } else {
        expect(v.credentialEnv, `${v.id} 需要凭证却没写 env 名`).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    }
  })

  it('解析器会挑出坏条目，而不是整份拒掉（一家写错不该让其余 11 家消失）', () => {
    const { vendors, errors } = parseVendorCatalog({
      vendors: [
        { id: 'ok', label: 'OK', baseUrl: 'https://x/v1', api: 'openai', credentialEnv: 'X_KEY', defaultModel: 'm', models: [] },
        { id: 'bad', label: 'Bad', baseUrl: 42, api: 'openai', credentialEnv: '', defaultModel: '', models: [] },
      ],
    })
    expect(vendors.map((v) => v.id)).toEqual(['ok'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('baseUrl must be a string')
  })

  it('重复 id 会被报出来', () => {
    const one = { id: 'dup', label: 'D', baseUrl: 'https://x/v1', api: 'openai', credentialEnv: '', defaultModel: '', models: [] }
    const { errors } = parseVendorCatalog({ vendors: [one, { ...one }] })
    expect(errors.some((e) => e.includes('duplicate vendor id'))).toBe(true)
  })
})

describe('wire ↔ 进程 契约', () => {
  it('catalog 声明的每个 wire 都有对应的 provider 服务目录', () => {
    const missing = declaredWires(catalog.vendors)
      .map((wire) => ({ wire, serviceId: providerServiceIdForWire(wire) }))
      .filter(({ serviceId }) => !serviceExists(serviceId))
    expect(
      missing,
      `这些 wire 声明了却没有进程兑现：${missing.map((m) => `${m.wire} → plugins/<plugin>/services/${m.serviceId}`).join(', ')}。` +
        `要么建这个 provider 进程（独立插件），要么别在 catalog 里声明这个 wire。`,
    ).toEqual([])
  })

  it('wire id → 服务 id 的映射就是 llm-provider-<wire>', () => {
    expect(providerServiceIdForWire('openai')).toBe('llm-provider-openai')
    expect(providerServiceIdForWire('opencode')).toBe('llm-provider-opencode')
  })

  it('当前只声明 openai 兼容 wire，且 12 家都归它', () => {
    expect(declaredWires(catalog.vendors)).toEqual([WIRE_OPENAI])
    expect(presetsForWire(WIRE_OPENAI, catalog.vendors)).toHaveLength(catalog.vendors.length)
    expect(catalog.vendors).toHaveLength(12)
  })

  it('presetsForWire 是排他的：别的 wire 拿不到 openai 的厂商', () => {
    expect(presetsForWire('opencode', catalog.vendors)).toEqual([])
  })

  it('一个都不属于任何 wire 的厂商不存在（防止漏填 api 变成孤儿）', () => {
    const orphans = catalog.vendors.filter((p) => !p.api || !p.api.trim())
    expect(orphans.map((p) => p.id)).toEqual([])
  })

  it('模拟「加了新 wire 但忘了建进程」会被抓住（证明这条断言真的会红）', () => {
    const withNewWire: VendorPreset[] = [
      ...catalog.vendors,
      { ...catalog.vendors[0]!, id: 'x', api: 'ghostwire' },
    ]
    const missing = declaredWires(withNewWire)
      .map((wire) => providerServiceIdForWire(wire))
      .filter((serviceId) => !serviceExists(serviceId))
    // 'ghostwire' 不该被判成有实现 —— 这就是 CI 会拦住的那个洞
    expect(missing).toEqual(['llm-provider-ghostwire'])
  })
})