import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** skills 插件 UI 构建（P6）。`base` 必须命名空间化，理由同 models/workbench/agents。 */
const PLUGIN_ID = 'skills'
const UI_BASE = `/plugins/${PLUGIN_ID}/ui/`
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')

export default defineConfig({
  base: UI_BASE,
  plugins: [vue()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: true,
    commonjsOptions: {
      include: [/node_modules/, /shared[\\/]dist/, /core-client[\\/]dist/],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0])
