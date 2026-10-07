import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** tools 插件 UI 构建（P7）。`base` 命名空间化，理由同其它插件。 */
const PLUGIN_ID = 'tools'
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
