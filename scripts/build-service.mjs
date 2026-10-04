/**
 * 服务构建 —— 打成**单文件、零外部依赖**的产物，落到它所属插件的 `dist/server/<id>/`。
 *
 * ## 为什么必须打单文件（P2 的核心）
 *
 * 今天的 `tsc` 产物是 `dist/index.js` + 一堆 `require('@osteosome/service-sdk')`。
 * 拷到任何一台**没装这个仓库的 pnpm workspace** 的机器上，Core 一 spawn 就是
 * `Cannot find module '@osteosome/service-sdk'` —— 也就是说「插件能分发」根本不成立。
 *
 * 依赖链只有 `service → sdk / shared → zod`，全是纯 JS，所以 esbuild 直接全打进去，
 * 只留 Node 内置模块。结果是一个可以单独拷走就运行的 `index.js`。
 *
 * ## 产物为什么归插件而不归服务
 *
 * ```
 * plugins/models/services/llm-provider-openai/   ← 源码（跟 git 走）
 * plugins/models/dist/server/llm-provider-openai/ ← 产物（gitignore）
 * ```
 *
 * **一个目录 = 一个插件的交付物**。打包 / 分发时「取 dist/ 就是全部」，
 * 而不是「一堆服务目录各自带 dist，还要记得哪些是插件的」。
 *
 * ## 为什么产物里还要带一份 service.json
 *
 * Core 只读产物（`plugin.json` 声明的服务在 `dist/` 里不存在 = 未构建 → 插件降级）。
 * 源码侧那份继续存在、继续被 CI 的 `service-manifest-sync` 校验 —— 那是**声明**；
 * 产物侧那份 `entry` 被改写成 `node index.js`，那是**可执行的真相**。
 *
 * 用法（各服务 package.json 的 build 脚本）：
 *   node ../../../../scripts/build-service.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const serviceDir = process.cwd()
const pluginDir = resolve(serviceDir, '..', '..')

const pkg = JSON.parse(readFileSync(join(serviceDir, 'package.json'), 'utf8'))
const serviceId = pkg.name.replace(/^@osteosome\//, '')

const outDir = join(pluginDir, 'dist', 'server', serviceId)
mkdirSync(outDir, { recursive: true })

const entry = join(serviceDir, 'src', 'index.ts')

await build({
  entryPoints: [entry],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  // 服务与 Core 之间是 stdio JSON-RPC；CommonJS 是 SDK 现在的形态（CJS 服务被 require 也没问题）
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // 只留 Node 内置模块（platform=node 已自动处理）；这里显式写出来是为了让意图可读：
  // 任何 workspace 包（@osteosome/*）都**必须被打进去** —— 打进去才等于「拷走就能跑」。
  // 一旦有人加了 external，产出会安静地变成「在仓库里能跑、拷出去不能跑」。
  logLevel: 'warning',
})

// service.json：改写 entry 后复制进产物（Core 只读这份，见文件头）
const manifest = JSON.parse(readFileSync(join(serviceDir, 'service.json'), 'utf8'))
const distManifest = { ...manifest, entry: 'node index.js' }
writeFileSync(join(outDir, 'service.json'), `${JSON.stringify(distManifest, null, 2)}\n`, 'utf8')

const bytes = readFileSync(join(outDir, 'index.js')).length
process.stdout.write(
  `[build] ${pkg.name} -> ${join('dist', 'server', serviceId, 'index.js')} (${Math.round(bytes / 1024)} KB, 单文件)\n`,
)
