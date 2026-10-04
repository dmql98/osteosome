import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * `@osteosome/ui` 的测试配置。
 *
 * ## 这里没有 `build`
 *
 * 这个包**不产出运行时产物**。曾经它有个 vite lib build，把 19 个组件打成一个
 * `dist/index.js`（94 KB，而 src 全部加起来才 44 KB —— 差的 50 KB 是被打进去的 vue）。
 * 后果是双份 vue 运行时：测试挂载 `Button` 时，组件内部的 `ref` 来自 dist 里那份 vue，
 * 而测试的 `@vue/test-utils` 用的是 node_modules 里那份，于是
 * `Cannot read properties of null (reading 'ce')` 这种看不懂的报错就来了。
 *
 * 消费方（client、models/ui、workbench/ui）一律通过 `exports` 直接引 `src/*.vue`，
 * 由**各自**的打包器处理 SFC —— vue 运行时因此在每个 bundle 里只有一份。
 *
 * 代价是消费方需要能处理 `.vue`（三个消费方都是 vite，都没问题）。
 * 好处是组件库不存在「产物与源码不同步」这种问题 —— 它根本没有产物。
 *
 * `package.json` 里的 `build` 因此只是 `vue-tsc --noEmit`：挡住「组件写坏了」，
 * 而不是产出什么。
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})