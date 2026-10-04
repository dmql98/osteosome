import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import type { ProxyOptions } from 'vite'

if (process.env.VITEST) process.env.NODE_ENV = 'test'

/**
 * `@osteosome/shared` 编译成 **CommonJS**（tsc + `__exportStar` / `defineProperty`），
 * 但它经 workspace 软链解析后真实路径在 `shared/dist/`（**不在 node_modules 里**），
 * 于是 rollup 的 commonjs 插件默认不覆盖它 → 按 ESM 解析 → 具名导出全部认不出，
 * 打包时报「X is not exported by ../shared/dist/index.js」。
 *
 * 之前没暴露这个问题：client 对 shared 只有 **type-only** 导入（编译期擦掉，打包根本看不到它）。
 * S3 的厂商目录是第一个运行时值导入，才撞上。
 *
 * 显式把 workspace 包的产物纳入 commonjs 处理，而不是改成深路径导入 —— 后者会把
 * `@osteosome/shared/dist/...` 这种内部路径写进业务代码。
 */
const workspaceCjs = [/shared[\\/]dist[\\/].*\.js$/, /sdk[\\/]ts[\\/]dist[\\/].*\.js$/]

const coreProxy: ProxyOptions = {
  target: 'http://127.0.0.1:1420',
  changeOrigin: true,
  configure(proxy: Parameters<NonNullable<ProxyOptions['configure']>>[0]) {
    proxy.on('proxyReq', (request) => {
      request.setHeader('origin', 'http://127.0.0.1:1420')
    })
  },
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // workspace 包产物是 CJS，且真实路径不在 node_modules → 必须显式让 commonjs 插件处理
  optimizeDeps: { include: ['@osteosome/shared'] },
  ssr: { noExternal: ['@osteosome/shared'] },
  server: {
    port: 5173,
    proxy: {
      '/health': coreProxy,
      '/events': coreProxy,
      '/api': coreProxy,
      '/runtime': coreProxy,
      // 插件 WebUI 产物（P3）。少了这一条，iframe 的 `/plugins/<id>/ui/index.html`
      // 会落在 Vite 的 SPA fallback 上 → 回宿主 index.html → 盒子里套一个完整工作台。
      // 与 /api 同一套判定：Core 会查 Origin 白名单，必须由 configure 统一改写。
      '/plugins': coreProxy,
    },
  },
  build: {
    outDir: '../core/dist/client',
    emptyOutDir: true,
    commonjsOptions: { include: workspaceCjs },
    rollupOptions: {
      // 同上：让 rollup 把这些 CJS 产物转成 ESM 语义，具名导出才可见
      external: [],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
