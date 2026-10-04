import { defineConfig } from 'vitest/config'

/**
 * `@osteosome/core-client` 的测试配置。
 *
 * `environment: 'jsdom'` 不是可选的：这个包是**浏览器端**代码 ——
 * `useEventBus` / `useServiceStatus` 挂载时要碰 `window`（onMounted + fetch + SSE），
 * 而默认的 node 环境里没有 `document`，挂载直接抛 `document is not defined`。
 *
 * 顺带说明为什么 `serviceStatus.test.ts` 在 node 下也能过：它只测响应式数据，
 * 不挂载组件。但**同一个包里两种环境需求**时，统一用 jsdom 更省心 ——
 * 分环境配置（`// @vitest-environment` 注释）会让「哪条用例在哪个环境跑」变成隐式知识。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})