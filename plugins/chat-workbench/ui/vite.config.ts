import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * chat-workbench 插件 UI 的构建配置（P6）。
 *
 * ## `base` 必须命名空间化 —— 这条到本插件才算真正被验证过
 *
 * 产物由 Core 伺服在 `/plugins/chat-workbench/ui/` 下。默认 `base: '/'` 会把 chunk
 * 写成 `/assets/index-xxx.js` —— 一个**全局**路径。
 *
 * 仓库里已经有三个带 UI 的插件（models / workbench / chat-workbench），
 * 每块 UI 各带一份 vue。若 base 写错，它们会请求到**同一个** URL，
 * 症状是「A 的界面加载到 B 的代码」。
 * `core/tests/plugin-ui-e2e.test.ts` 里那条「两个插件的 asset 路径不重叠」的断言
 * 就是为此存在的：它验的不是「能不能取到 index.html」，是**命名空间有没有生效**。
 */
const PLUGIN_ID = 'chat-workbench'
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
     * 必须显式 include shared / core-client —— 与另两个插件 UI 同一个坑。
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