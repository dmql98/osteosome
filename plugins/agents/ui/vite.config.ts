import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * agents 插件 UI 的构建配置（P5）。
 *
 * `base` 必须命名空间化（同 models / workbench）：产物由 Core 伺服于 `/plugins/agents/ui/`，
 * 默认 `base:'/'` 会把 chunk 写成全局 `/assets/...`，多插件同装时「A 的界面加载到 B 的代码」。
 */
const PLUGIN_ID = 'agents'
const UI_BASE = `/plugins/${PLUGIN_ID}/ui/`
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')

export default defineConfig({
  base: UI_BASE,
  plugins: [vue()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: true,
    // 显式 include shared / core-client 的 CJS 产物（不在 node_modules 下），见 models/ui 的注释
    commonjsOptions: {
      include: [/node_modules/, /shared[\\/]dist/, /core-client[\\/]dist/],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0])
