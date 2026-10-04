#!/usr/bin/env node
/**
 * 把一个插件装配成可分发目录（P8）。
 *
 * ## 为什么是「装配」而不是「打包」
 *
 * 交付物就是一个目录：`plugin.json` + 插件自带数据 + `dist/`。没有 tar/zip，
 * 也不做压缩 —— 因为「解包」这一步唯一会出错的地方是路径穿越，而没有解包就没有
 * 那类 bug。要发 zip 是发上面这个目录的 zip，与本脚本无关。
 *
 * ## 本脚本管什么、不管什么
 *
 * 管：**产物是否齐全**。这是唯一「拷出去才发现」的问题 ——
 * `dist/server/<sid>/index.js` 缺了，Core 启动时会报「未构建」；
 * `dist/ui/` 缺了，界面直接 404。两者都必须在**打包时**说清楚，
 * 而不是等用户装上。
 *
 * 不管：清单的语义校验（schema / protocolVersion / coreCompatibility /
 * publishes-subscribes 白名单）。那五条 Core 扫盘时已经全做了，这里再写一遍
 * 就是第二份规则，迟早与 `core/src/service-manager/manifest.ts` 漂移 ——
 * 而「pack 说没问题、Core 装不上」比不检查更糟。
 * 真正的证据是 `core/tests/pack-plugin.test.ts`：**把 pack 出来的目录交给
 * Core 的 `scanPlugins` 跑一遍**，用别人的校验器验自己的产物，不复制规则。
 *
 * ## 不进交付物的东西
 *
 * `services/`（后端源码）、`ui/`（前端源码）、`package.json` /
 * `tsconfig*.json`（构建配置）、`node_modules/`、`*.map`（运行期读不到，且体积是主角）、
 * `.data/`（某台机器上的运行期数据，发出去就是把别人的会话塞给别人）。
 * 它们在仓库里，不在发行版里 ——
 * 拷进来只会让人以为「改改源码就能改行为」，而 Core 只认 `dist/`。
 *
 * 用法：
 *   node scripts/pack-plugin.mjs              # 装配 plugins/ 下全部插件
 *   node scripts/pack-plugin.mjs models       # 按 id
 *   pnpm --filter '@osteosome/plugin-models' pack   # 按 pnpm 过滤器（在插件目录里跑）
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins')
const PACK_DIR = path.join(REPO_ROOT, 'pack')

/** 不进交付物的目录（`dist/` 要进，所以不在此列） */
const SKIP_DIRS = new Set(['services', 'ui', 'node_modules', 'pack'])
/** 不进交付物的文件（构建与包管理器的元数据） */
const SKIP_FILES = new Set(['package.json', 'pnpm-lock.yaml'])
const SKIP_FILE_RE = /^tsconfig(\..+)?\.json$/

/**
 * cpSync 的 filter —— 决定**这一份拷贝**带不带某个路径。
 *
 * 排掉三类：
 * - `node_modules/`：依赖由 Core 侧的「零外部依赖 bundle」保证，发它既没用又危险；
 * - `*.map`：Core 是 `node index.js` 起的，没开 `--enable-source-maps`，
 *   这些文件运行期**根本不会被读**，而它们把交付物撑大了约七成
 *   （models：2000 KB 里 1538 KB 是 map）。同时 map 内含源码原文 ——
 *   发出去等于把 `services/` 的内容换个形式发了，与「不发源码」自相矛盾。
 * - `.data/`：**运行期数据**。session 服务在 `service.dataDir` 为空时回退到
 *   相对路径 `'.data'`（见 `plugins/chat-workbench/services/session/src/index.ts`），
 *   于是本地跑过的会话会写进 `dist/server/session/.data/`。
 *   它有 `.gitignore` 挡着不入库，但**挡不住拷贝** —— 发出去等于把某台机器的
 *   会话历史塞进别人的全新安装里，而且还会被当成「新装就自带历史」的 bug 查半天。
 */
function shippable(p) {
  const parts = p.split(path.sep)
  if (parts.includes('node_modules')) return false
  if (parts.includes('.data')) return false
  if (path.basename(p).endsWith('.map')) return false
  return true
}

/** 目录总大小 —— 打印出来才看得见「打进去一个 node_modules」这类事故 */
function dirBytes(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(p)
    else total += statSync(p).size
  }
  return total
}

function loadManifest(pluginDir) {
  const file = path.join(pluginDir, 'plugin.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${pluginDir}: plugin.json 解析失败：${String(err)}`)
  }
}

/** 本插件要交付的每个服务在 dist 下必须存在的文件 */
function checkServices(pluginDir, manifest) {
  const errors = []
  for (const sid of manifest.services ?? []) {
    const dir = path.join(pluginDir, 'dist', 'server', sid)
    const indexJs = path.join(dir, 'index.js')
    const serviceJson = path.join(dir, 'service.json')

    // 先分清「没构建」和「构建坏了」：前者跑一次 build，后者要改 build 脚本。
    // 混成一句「dist/server 不存在」会把人指向错误的修法。
    if (!existsSync(indexJs)) {
      errors.push(`服务 ${sid} 未构建：缺 plugins/${manifest.id}/dist/server/${sid}/index.js（跑 pnpm build）`)
      continue
    }
    if (!existsSync(serviceJson)) {
      errors.push(`服务 ${sid} 的 service.json 没被打进产物：缺 dist/server/${sid}/service.json`)
      continue
    }

    let sm
    try {
      sm = JSON.parse(readFileSync(serviceJson, 'utf8'))
    } catch (err) {
      errors.push(`服务 ${sid} 的 service.json 解析失败：${String(err)}`)
      continue
    }
    // 这两条是「拷走就能跑」的机械前提：Core 按 service.json 的 entry spawn，
    // 而 entry 若还是 `../../src/index.ts` 这种相对源码的路径，产物离开仓库就是死的。
    if (sm.entry !== 'node index.js') {
      errors.push(`服务 ${sid} 的 entry 是 ${JSON.stringify(sm.entry)}，产物里必须是 "node index.js"`)
    }
    if (sm.id !== sid) {
      errors.push(`服务 ${sid} 的 service.json.id 是 ${JSON.stringify(sm.id)}，与目录名不一致`)
    }
  }
  return errors
}

/** 声明了 ui.views 却没构建前端 —— Core 会把界面回 404，所以打包时就拦住 */
function checkUi(pluginDir, manifest) {
  const views = manifest.ui?.views ?? []
  if (views.length === 0) return []
  const errors = []
  const uiRoot = path.join(pluginDir, 'dist', 'ui')
  if (!existsSync(uiRoot)) {
    errors.push(`声明了 ${views.length} 个 ui.views，但 dist/ui 不存在（跑 pnpm --filter './plugins/*' run build）`)
    return errors
  }
  for (const v of views) {
    // entry 可能带 hash（`index.html#settings`），文件部分才是磁盘上的路径
    const file = path.join(uiRoot, v.entry.split('#')[0] ?? v.entry)
    if (!existsSync(file)) {
      errors.push(`视图 ${v.id} 的 entry ${v.entry} 找不到（期望 dist/ui/${v.entry.split('#')[0]}）`)
    }
  }
  return errors
}

/**
 * 只做「产物齐全」这一类检查，其余交给 Core。
 * 全部错误一次性列出 —— 打包失败时通常不止一处，逐条改比逐次重跑快。
 */
function preflight(pluginDir, manifest) {
  const errors = []

  if (typeof manifest.id !== 'string' || manifest.id === '') {
    errors.push('plugin.json 缺 id')
    return errors
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    errors.push('plugin.json 缺 version（升级/回滚要按它改名 .bak-<版本>）')
  }
  // Core 以 id 为准但会报「id != 目录名」。这里直接判失败：交付物的目录名
  // 必须等于 id，否则拷进 plugins/ 就会带一条告警启动。
  if (manifest.id !== path.basename(pluginDir)) {
    errors.push(`目录名 ${path.basename(pluginDir)} != id ${manifest.id}（交付物目录名必须等于 id）`)
  }

  errors.push(...checkServices(pluginDir, manifest))
  errors.push(...checkUi(pluginDir, manifest))
  return errors
}

/** 复制一份插件；只带清单、自带数据与产物 */
function copyOne(pluginDir, manifest, outDir) {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  cpSync(path.join(pluginDir, 'plugin.json'), path.join(outDir, 'plugin.json'))

  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    if (entry.isFile() && (SKIP_FILES.has(entry.name) || SKIP_FILE_RE.test(entry.name))) continue
    cpSync(path.join(pluginDir, entry.name), path.join(outDir, entry.name), {
      recursive: true,
      filter: shippable,
    })
  }
}

/**
 * 对**输出目录**再跑一遍同样的检查。
 *
 * 为什么必须有这一步：preflight 验的是源目录，而拷贝本身会漏东西 ——
 * 第一版就把 `dist/` 排在了要拷的目录之外，于是 preflight 全绿、
 * 输出里一个产物都没有，而这种错**只有装配完才看得见**。
 * 用同一个函数验输出，不引入第二套规则。
 */
function verifyOutput(outDir, manifest) {
  const errors = preflight(outDir, manifest)
  if (errors.length === 0) return []
  rmSync(outDir, { recursive: true, force: true })
  return errors.map((e) => `装配后输出缺东西：${e}`)
}

function resolveTargets(argv) {
  if (argv.length > 0) {
    return argv.map((a) => (path.isAbsolute(a) || existsSync(a) ? path.resolve(a) : path.join(PLUGINS_DIR, a)))
  }
  // 在插件目录里跑（pnpm run pack）→ 只装配这一个
  if (existsSync(path.join(process.cwd(), 'plugin.json'))) return [process.cwd()]
  // 在仓库根跑（node scripts/pack-plugin.mjs）→ 全部
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(PLUGINS_DIR, e.name, 'plugin.json')))
    .map((e) => path.join(PLUGINS_DIR, e.name))
}

function main() {
  const targets = resolveTargets(process.argv.slice(2))
  if (targets.length === 0) {
    console.error('[pack] plugins/ 下没有带 plugin.json 的目录')
    process.exitCode = 1
    return
  }

  const failed = []
  const packed = []

  for (const dir of targets) {
    let manifest
    try {
      manifest = loadManifest(dir)
    } catch (err) {
      failed.push({ id: path.basename(dir), errors: [err.message] })
      continue
    }
    if (manifest === null) {
      failed.push({ id: path.basename(dir), errors: ['没有 plugin.json'] })
      continue
    }

    const errors = preflight(dir, manifest)
    if (errors.length > 0) {
      failed.push({ id: manifest.id, errors })
      continue
    }

    const outDir = path.join(PACK_DIR, manifest.id)
    copyOne(dir, manifest, outDir)
    const after = verifyOutput(outDir, manifest)
    if (after.length > 0) {
      failed.push({ id: manifest.id, errors: after })
      continue
    }
    packed.push({ id: manifest.id, outDir, bytes: dirBytes(outDir) })
  }

  for (const p of packed) {
    console.log(`[pack] ${p.id} → ${path.relative(REPO_ROOT, p.outDir)}/  (${(p.bytes / 1024).toFixed(1)} KB)`)
  }

  if (failed.length > 0) {
    console.error('')
    for (const f of failed) {
      console.error(`[pack] ${f.id} 装配失败：`)
      for (const e of f.errors) console.error(`  - ${e}`)
    }
    console.error(`[pack] ${failed.length} 个插件未通过，已输出 ${packed.length} 个`)
    process.exitCode = 1
  }
}

main()
