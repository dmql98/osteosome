/**
 * 构建器提供的模块类型补丁。
 *
 * `?raw` 是 Vite 的约定（把文件内容当字符串默认导出），TypeScript 不认识它 ——
 * 没有这条声明，`import body from '../../../catalog.json?raw'` 会报 TS2307。
 *
 * 为什么用它而不是 `readFileSync`：插件 UI 的用例跑在 **jsdom** 环境里，
 * 那里 `node:fs` 被 Vite 外部化成空模块（`fileURLToPath is not a function`）。
 * `?raw` 是纯构建期能力，两个环境都成立。
 */
declare module '*?raw' {
  const content: string
  export default content
}
