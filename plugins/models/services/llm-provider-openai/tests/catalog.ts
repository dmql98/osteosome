/**
 * 测试用的 catalog 加载器 —— 读插件自带的 `plugins/models/catalog.json`。
 *
 * ## 为什么测试要读磁盘
 *
 * P5 起厂商预设**不再有编译期副本**，数据只有一份，就是这个文件。
 * 测试若自己手抄一份，就等于在测试里造了第二个真相源 ——
 * 「数据改了但测试还绿」正是这种结构最容易出的事。
 *
 * 顺带这也是对**真实读取路径**的验证：服务在运行时经 `plugins.readFile` 读同一份文件，
 * 这里读同一个文件、同一套 `parseVendorCatalog`，于是校验规则也只有一份。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVendorCatalog, type VendorPreset } from '@osteosome/shared'

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
// 往上两级：<plugin>/services/<svc> → <plugin>/services → <plugin>
const CATALOG_PATH = join(PACKAGE_ROOT, '..', '..', 'catalog.json')

export function loadCatalogPresets(): VendorPreset[] {
  const { vendors, errors } = parseVendorCatalog(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
  expectNoErrors(errors)
  return vendors
}

export const VENDOR_PRESETS: readonly VendorPreset[] = loadCatalogPresets()

/**
 * provider id → 预设；**找不到返回 undefined**（替代已删除的 `findVendorPreset`）。
 *
 * 保持 undefined 语义而不是抛错：有一条测试断言的正是「`anthropic` 不在表里」。
 * 把「查不到」变成异常，就只能靠 `try/catch` 断言不存在 —— 那是在测语言，不是测数据。
 */
export function findVendor(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find((v) => v.id === id)
}

/** 同上，但要求一定存在（取出来直接用的场合，避免各处写 `!`） */
export function mustFindVendor(id: string): VendorPreset {
  const found = findVendor(id)
  if (!found) throw new Error(`catalog.json has no vendor '${id}'`)
  return found
}

function expectNoErrors(errors: string[]): void {
  if (errors.length > 0) {
    throw new Error(`catalog.json is invalid:\n  ${errors.join('\n  ')}`)
  }
}