/**
 * 数据目录路径工具 —— Core 侧 dataDir / pluginsDir / dist 派生。
 *
 * ## 用户数据的最终形状（插件化 P1）
 *
 * ```
 * <安装目录>/osteosome/          ← installRoot()：发行版里是 exe 旁边
 * ├── core/                     ← Core 运行时
 * ├── plugins/                  ← 插件（开发时源码也在此处）
 * └── userData/                 ← dataDir：**全部用户数据，跟着人走**
 *     ├── core/                 ←   Core 自己的：preferences.json / credentials.json / 日志
 *     └── plugin/<pluginId>/    ←   插件的用户数据；里面有什么由插件自己定
 * ```
 *
 * 目录约定的单一真相源（`pluginDataDir` / `coreDataDir`）在 `shared/src/paths.ts`，
 * 服务与 Core 共用；本文件只管「根从哪来」。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { coreDataDir, pluginDataDir } from '@osteosome/shared'

export { pluginDataDir, coreDataDir }

/** 确保目录存在（recursive），返回该目录绝对路径 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * **运行中的这份 Core 的版本号**（P2）—— 拿它判 `plugin.json` 的 `coreCompatibility`。
 *
 * ## 为什么不 import package.json
 *
 * `resolveJsonModule` + import 会把它**打进 bundle**，版本在打包那一刻就冻住了 ——
 * 改了 package.json 但没重新构建，跑起来的 Core 仍报旧版本，而判定正好依赖这个值
 * （症状：明明填对了版本却被拦，或反过来）。
 *
 * ## 为什么不用 `import.meta.url` 定位
 *
 * Core 编译成 **CommonJS**（`tsconfig.build.json`），那里没有 `import.meta`。
 * 入口脚本路径用 `process.argv[1]` 拿：它同时覆盖 `node core/dist/main.js` 与
 * 打包后的 exe 两种启动方式，且不需要任何编译期技巧。
 *
 * ## 读不到时为什么退 `0.0.0` 而不是猜一个
 *
 * `0.0.0` 会让所有声明 `min: "0.1.0"` 的插件被判为「不满足」，即**静默拦住所有插件** ——
 * 可见的坏（插件不启动 + 日志说明）好过不可见的坏（版本号好看但拦住不该拦的）。
 * 所以退 0.0.0 并由 `startCore` 打警告，不假装知道。
 *
 * @param entry 入口脚本路径（`.../core/dist/main.js`）；测试可注入
 */
export function coreVersion(entry: string = process.argv[1] ?? ''): string {
  if (!entry) return '0.0.0'
  try {
    // 入口在 <core>/dist/main.js → 上两级才是 <core>/package.json
    const raw = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (raw.name !== '@osteosome/core') return '0.0.0'
    return typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** `${dataDir}/core/preferences.json` —— Core 自己的偏好 */
export function preferencesFile(dataDir: string): string {
  return join(coreDataDir(dataDir), 'preferences.json')
}

/**
 * 发行版标记文件 —— **有它才认为「这是一份发行版」**。
 *
 * ## 为什么需要判据
 *
 * 数据根要落在 exe 旁边（自包含、整目录拷走即换机器），但开发时 Core 是
 * `node core/dist/main.js` 起的：`process.execPath` 指向 **node.exe**，
 * 拿它的目录当安装目录会得到一个荒谬的路径。所以必须能区分「发行版」与「开发」。
 *
 * ## 为什么用标记文件而不是别的
 *
 * 候选与它们的毛病：
 * - 「exe 同级有没有 `plugins/`」—— 开发时仓库根也有 `plugins/`，判不出来；
 * - 「exe 是不是 bundler 产物」—— 打包方式一变就失效；
 * - **「同级有没有这个标记文件」** —— 发行包必然带上，开发仓库不会刻意造它，
 *   且它是**显式声明**而不是推断。
 */
export const DIST_MARKER = '.osteosome-dist'

/**
 * 安装根 `<exe 所在目录>/osteosome`；**不是发行版则返回 undefined**。
 *
 * `exists` 可注入是为了能测（判据本身就该有测试，见 `core/tests/sse.test.ts`）。
 */
export function installRoot(
  execPath: string = process.execPath,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const exeDir = dirname(execPath)
  return exists(join(exeDir, DIST_MARKER)) ? join(exeDir, 'osteosome') : undefined
}

/**
 * 开发 / 无发行标记时的数据根 —— 退到**用户目录**。
 *
 * | 平台 | 路径 |
 * |---|---|
 * | Windows | `%LOCALAPPDATA%\osteosome`（退 `%APPDATA%`） |
 * | 其它 | `$XDG_DATA_HOME/osteosome`（退 `~/.local/share/osteosome`） |
 *
 * Windows 刻意用 **LOCAL** 而不是 `APPDATA%`：`%APPDATA%` 常被域策略漫游同步，
 * 密钥跟着漫游到别的机器上是**我们不替用户做的决定**。
 * `$XDG_DATA_HOME` 而不是 `~/.config`：这里装的不只是配置，还有会话。
 *
 * `env` / `home` / `platform` 可注入是为了能测。
 */
export function userDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || join(home, 'AppData', 'Local')
    return join(base, 'osteosome')
  }
  const xdg = env.XDG_DATA_HOME?.trim()
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.local', 'share'), 'osteosome')
}

/**
 * 旧的数据根（`<cwd>/.data`）—— 只为**一次性迁移**而存在。
 *
 * 迁移判据见 {@link migrateLegacyDataDir}：只在「用的是缺省值」且目标还是空的时候做，
 * 显式 `--data` 的用户（包括集成测试与 smoke）一概不碰。
 */
export const LEGACY_DATA_DIR = '.data'

/**
 * 平铺布局 → 三层布局的映射表（只列**已知**项）。
 *
 * 两条迁移路径共用它：`<cwd>/.data` → 新根（P0 之前）、以及同一个根里的
 * 扁平 → `core/`+`plugin/`（P0 之后）。未登记的文件一律进 `core/`
 * —— 那只会是 Core 的日志之类，插件的数据不可能出现在平铺层。
 */
const LEGACY_MAP: Record<string, string> = {
  'preferences.json': 'core/preferences.json',
  'credentials.json': 'core/credentials.json',
  // 会话归 chat-workbench 插件（session 是它的服务）
  sessions: 'plugin/chat-workbench/sessions',
}

/**
 * 同一目录内**扁平布局 → 三层布局**的迁移（P1）。
 *
 * ## 为什么需要它（这是 P0 留下的坑）
 *
 * P0 把数据根从仓库挪到用户目录，布局还是**扁平**的（`<dataDir>/preferences.json`）。
 * P1 把 Core 自己的数据挪进 `<dataDir>/core/` —— 于是 P0 时代写下的偏好与密钥
 * **留在原地没人读**，用户的表现是「升级后配置与密钥全没了」。
 *
 * 与 {@link migrateLegacyDataDir} 的区别：那个是「换根」（旧根在别处），这个是
 * 「同一个根里换布局」。两者都只搬文件、都不删源，出错时不至于把人锁在门外。
 *
 * @returns 搬了哪些条目（相对 dataDir）；没动手时返回空数组
 */
export function migrateFlatLayout(dataDir: string): string[] {
  // 目标已经有东西 = 已经迁过（或本来就在新布局）
  const coreDir = join(dataDir, 'core')
  if (existsSync(join(coreDir, 'preferences.json')) || existsSync(join(coreDir, 'credentials.json'))) {
    return []
  }
  const moved: string[] = []
  for (const [name, toRel] of Object.entries(LEGACY_MAP)) {
    const from = join(dataDir, name)
    if (!existsSync(from)) continue
    const to = join(dataDir, toRel)
    mkdirSync(dirname(to), { recursive: true })
    if (statSync(from).isDirectory()) {
      cpSync(from, to, { recursive: true })
    } else {
      copyFileSync(from, to)
    }
    moved.push(toRel.split('\\').join('/'))
  }
  return moved
}

/**
 * 把旧 `<cwd>/.data` 里的东西**复制**到新的数据根（不删旧的）。
 *
 * 为什么复制而不是移动：这一步动的是密钥。移动中途失败 = 数据卡在中间态，
 * 复制则最坏情况只是留一份没人再读的陈旧副本 —— 恢复成本不对称，所以选保守的一侧。
 *
 * 只在下列条件全满足时动手：
 * 1. `dataDir` 来自**缺省值**（显式 `--data` / `OST_DATA` 说明部署者另有安排，不该插手）；
 * 2. 目标是新出现的或空的（**已有数据绝不覆盖** —— 那可能是用户特意 `--data` 指过来的备份）；
 * 3. 旧目录确实存在。
 *
 * 旧目录是**平铺**的（`preferences.json` 与 `sessions/` 同级），新布局分了两层，
 * 所以按 {@link LEGACY_MAP} 搬运；未登记的文件一律进 `core/`（那些是 Core 的日志之类）。
 *
 * @returns 搬运了哪些条目（相对新 dataDir 的路径）；没动手时返回空数组
 */
export function migrateLegacyDataDir(dataDir: string, cwd: string, isDefault: boolean): string[] {
  if (!isDefault) return []
  const legacy = join(cwd, LEGACY_DATA_DIR)
  if (legacy === dataDir || !existsSync(legacy)) return []
  try {
    if (existsSync(dataDir) && readdirSync(dataDir).length > 0) return []
  } catch {
    return []
  }
  const moved: string[] = []
  for (const name of readdirSync(legacy)) {
    const from = join(legacy, name)
    const toRel = LEGACY_MAP[name] ?? join('core', name)
    const to = join(dataDir, toRel)
    if (statSync(from).isDirectory()) {
      cpSync(from, to, { recursive: true })
    } else {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
    moved.push(toRel.split('\\').join('/'))
  }
  return moved
}