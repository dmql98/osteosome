import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * workbench 插件 UI 的构建配置（P6）。
 *
 * ## `base` 与 models 那份完全一样的原因
 *
 * 产物由 Core 伺服在 `/plugins/workbench/ui/` 下。默认 `base: '/'` 会把 chunk 写成
 * `/assets/index-xxx.js` —— 一个**全局**路径。
 *
 * 这条到 P6 才第一次真正被验证：之前仓库里只有**一个**带 UI 的插件，即便 base 写错也看不出来。
 * 搬完 workbench 就是两个插件同时在（models + workbench），两块 UI 各带一份 vue ——
 * 若两边都请求同一个全局 URL，「A 的界面加载 B 的代码」就会当场发生。
 * `core/tests/plugin-ui-e2e.test.ts` 里的那条断言（`html` 必须含 `/plugins/workbench/ui/assets/`）
 * 就是为此存在的：它验的不是「能不能取到 index.html」，是**命名空间有没有生效**。
 */
const PLUGIN_ID = 'workbench'
const UI_BASE = `/plugins/${PLUGIN_ID}/ui/`
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')

export default defineConfig({
  base: UI_BASE,
  plugins: [vue()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: true,
    /**
     * 必须显式 include shared —— 与 models/ui 同一个坑。
     *
     * pnpm 的 workspace 依赖是**符号链接**，vite 解析后拿到真实路径
     * （`shared/dist/index.js` / `sdk/core-client/dist/index.js`），
     * 而它**不在 node_modules 里**。`@vitejs/plugin-commonjs` 的默认 include 只有
     * `/node_modules/`，于是这些 CJS 产物没被转成 ESM，rollup 按 ESM 解析它们 ——
     * 报错是那句很难定位的「X is not exported by .../dist/index.js」。
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