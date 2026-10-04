/**
 * 插件自带目录的**运行时**读取（P5）。
 *
 * ## 为什么不再静态 import
 *
 * 原来那份 12 家预设是 `shared` 里的编译期常量。现在它在
 * `plugins/models/catalog.json`，构建时被复制进 `dist/ui/`，
 * 页面运行时 `fetch` 它。
 *
 * 「改成运行时会不会让首屏的厂商清单晚一拍」—— 会，而且这正是原来那条注释担心的。
 * 处置不是「回到静态 import」，而是**两件事都做**：
 *
 * 1. `index.html` 里的 `<link rel="preload" as="fetch">` 提前发起请求，
 *    所以它与 bundle 的下载是**并行**的，不是串行等 JS；
 * 2. 拿不到就**渲染错误态并给出重试**，而不是空列表 ——
 *    「厂商清单空着」和「清单还在路上」在界面上必须能区分开。
 *
 * ## 这份文件与服务端读的是同一份
 *
 * 服务端经 `plugins.readFile` 读插件目录里的原件，UI 读构建复制进产物的副本。
 * 一份被编写的文件，两个投递路径 —— 所以「界面上有的厂商，服务一定认」。
 * 校验规则也只有一份（`shared` 的 `parseVendorCatalog`）。
 */
import { ref, type Ref } from 'vue'
import { parseVendorCatalog, type VendorPreset } from '@osteosome/shared'

/** 构建时复制进 `dist/ui/` 的那份（vite.config.ts 的 closeBundle 钩子负责复制） */
export const CATALOG_URL = 'catalog.json'

export type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; vendors: VendorPreset[]; warnings: string[] }
  | { status: 'failed'; reason: string }

export interface CatalogLoader {
  state: Ref<CatalogState>
  /** 重新拉一次（失败态上的「重试」按钮用它） */
  reload(): Promise<void>
}

export function useCatalog(): CatalogLoader {
  const state = ref<CatalogState>({ status: 'loading' })

  async function reload(): Promise<void> {
    state.value = { status: 'loading' }
    let raw: unknown
    try {
      const response = await fetch(CATALOG_URL, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      raw = await response.json()
    } catch (err) {
      state.value = {
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      }
      return
    }
    const { vendors, errors } = parseVendorCatalog(raw)
    if (vendors.length === 0) {
      // 文件拿到了却一条都用不了 —— 当失败处理，因为空清单对用户没有意义
      state.value = {
        status: 'failed',
        reason: errors.length > 0 ? errors.join('；') : 'catalog.json 里没有任何厂商',
      }
      return
    }
    state.value = { status: 'ready', vendors, warnings: errors }
  }

  return { state, reload }
}