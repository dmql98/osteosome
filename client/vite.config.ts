import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import type { ProxyOptions } from 'vite'

if (process.env.VITEST) process.env.NODE_ENV = 'test'

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
  server: {
    port: 5173,
    proxy: {
      '/health': coreProxy,
      '/events': coreProxy,
      '/api': coreProxy,
      '/runtime': coreProxy,
    },
  },
  build: {
    outDir: '../core/dist/client',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
