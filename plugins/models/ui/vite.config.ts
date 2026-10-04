import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * models 插件 UI 的构建配置（P5）。
 *
 * ## `base` 不是默认值，这是本文件最重要的一行
 *
 * 产物由 Core 伺服在 `/plugins/models/ui/` 下。Vite 默认 `base: '/'` 会把 chunk 写成
 * `/assets/index-xxx.js` —— 一个**全局**路径。两个插件各带一份 vue 时，
 * 两边都会请求同一个 URL，于是「A 的界面加载到 B 的代码」，
 * 而且只在同时装两个插件时出现（单个插件时完全正常）。
 *
 * 命名空间前缀不是洁癖，是这个 bug 的唯一解法。
 */
const PLUGIN_ID = 'models'
const UI_BASE = `/plugins/${PLUGIN_ID}/ui/`
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')
/** 插件自带的目录数据（与服务端 `plugins.readFile` 读的是同一份**源文件**） */
const CATALOG_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.json')

/**
 * 把 `catalog.json` 复制进产物。
 *
 * ## 为什么要复制而不是让 UI 去别处取
 *
 * UI 在浏览器里只能读 Core 伺服的东西，而 Core 的插件 UI 路由只伺服 `dist/ui/`。
 * 所以构建时把插件自带的这份文件放进去，UI 就能
 * `fetch('/plugins/models/ui/catalog.json')`。
 *
 * **一份被编写的文件，两个投递路径**：服务端读插件目录里的原件，UI 读产物里的副本。
 * 副本由构建生成、没人手改 —— 这才是「同一份数据」的意思；
 * 两份各自维护才是漂移的起点（而漂移的症状是「界面上有的厂商，服务不认」）。
 *
 * ## 为什么挂在 closeBundle 而不是写成第二个命令
 *
 * 挂在构建里，`dist/ui` 就**不可能**缺这份文件。
 * 写成 `vite build && node copy.mjs` 的话，总有一天有人只跑前一条命令，
 * 而症状是「UI 报 catalog 读不到」—— 离原因很远。
 */
function copyCatalogToOutDir() {
  return {
    name: 'osteosome-copy-catalog',
    closeBundle() {
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(resolve(OUT_DIR, 'catalog.json'), readFileSync(CATALOG_SRC))
    },
  }
}

export default defineConfig({
  base: UI_BASE,
  plugins: [vue(), copyCatalogToOutDir()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // 产物进的是 gitignore 的 dist/，sourcemap 对排障有用（用户报「界面坏了」时能看）
    sourcemap: true,
    /**
     * 为什么必须显式 include shared。
     *
     * pnpm 的 workspace 依赖是**符号链接**，vite 解析后拿到的是真实路径
     * （`shared/dist/index.js` / `sdk/core-client/dist/index.js`），而它**不在 node_modules 里**。
     * `@vitejs/plugin-commonjs` 的默认 include 只有 `/node_modules/`，
     * 于是 shared 的 CJS 产物没被转成 ESM，rollup 按 ESM 解析它 ——
     * 结果是那句很难定位的报错：
     * 「`parseVendorCatalog` is not exported by shared/dist/index.js」。
     *
     * （shared 里那段「具名再导出」注释是为同一种症状写的，但它只解决
     * “导出名不可见”，不解决“整个文件被当成 ESM”。两件事都得做。）
     *
     * `core-client` 是 P6 之后加进来的另一个 workspace 包，同一个坑。
     */
    commonjsOptions: {
      include: [/node_modules/, /shared[\\/]dist/, /core-client[\\/]dist/],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0])