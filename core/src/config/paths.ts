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
 *     ├── core/                 ←   Core 自己的：preferences.json（布局 / 主题 / 插件启停）/ 日志
 *     └── plugin/<pluginId>/    ←   插件的用户数据；里面有什么由插件自己定
 * ```
 *
 * 目录约定的单一真相源（`pluginDataDir` / `coreDataDir`）在 `shared/src/paths.ts`，
 * 服务与 Core 共用；本文件只管「根从哪来」。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
 * 引导配置文件名 —— **放在应用根，与数据目录无关**。
 *
 * 为什么必须在数据目录之外：文件里的 `dataDir` 决定数据目录在哪，
 * 而偏好（`preferences.json`）住在数据目录里 —— 把「数据目录」这个设置
 * 存进偏好就成了鸡生蛋：下次启动不知道去哪读它。
 */
export const BOOT_CONFIG_NAME = 'ost.config.json'

/**
 * 应用根（开发跑）：入口 `.../core/dist/main.js` 反推两级。
 *
 * 用入口而不是 `process.cwd()` 判定，是因为 cwd 由启动方式决定
 * （`start-client.cmd` 用 `/D "%~dp0"` 把它钉在仓库根，但 `node <任意路径>/main.js` 不会）——
 * 数据根这类「用户数据最终去哪」的答案不能跟着 cwd 漂。
 *
 * 判据与 {@link coreVersion} 同一个：入口的上一级必须是 `@osteosome/core` 的 package.json，
 * 否则说明这份 Core 不在预期布局里（比如测试注入了别的入口）→ 返回 undefined，
 * 让调用方退回 cwd。
 *
 * @param entry 入口脚本路径（`.../core/dist/main.js`）；测试可注入
 */
export function appRoot(
  entry: string = process.argv[1] ?? '',
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (!entry) return undefined
  try {
    const distDir = dirname(entry)
    const pkg = join(distDir, '..', 'package.json')
    if (!exists(pkg)) return undefined
    const raw = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }
    if (raw.name !== '@osteosome/core') return undefined
    return resolve(join(distDir, '..', '..'))
  } catch {
    return undefined
  }
}

/** `<应用根>/ost.config.json` —— 引导配置（见 {@link BOOT_CONFIG_NAME}） */
export function bootConfigFile(root: string): string {
  return join(root, BOOT_CONFIG_NAME)
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

/**
 * 插件用户数据归位：Core 代管的插件数据 → 各插件自己的目录。
 *
 * ## 搬什么
 *
 * | 从 | 到 | 为什么 |
 * |---|---|---|
 * | `<dataDir>/core/credentials.json` | `<dataDir>/plugin/models/credentials.json` | 密钥归**使用方**插件（§4：密钥该在它的服务与 UI 都读得到的地方） |
 * | `<dataDir>/core/preferences.json` 的 `llm` 段 | `<dataDir>/plugin/models/preferences.json`（**去掉 `llm` 这层壳**） | 接入清单是 models 插件的用户配置，不是 Core 的偏好 |
 *
 * ## 三条纪律
 *
 * 1. **只在目标不存在时搬**（`plugin/models/*.json` 已经在 = 迁过了，或用户本来就这么放的）。
 *    绝不覆盖已有数据 —— 那可能是用户后来自己改过的一份。
 * 2. **密钥是「复制 → 校验 → 才删源」**，与 {@link migrateLegacyDataDir} 的纯复制不同：
 *    那一步最坏情况是留一份没人读的副本，而这里留副本意味着**明文密钥继续躺在 Core 侧**，
 *    恰好是这次要拆掉的那件事。校验通过才删源，两头都不会出现「密钥消失」。
 * 3. **`llm` 段只在写入成功后才从 Core 偏好里摘掉**：写失败就保持原样，
 *    下次启动再试一次 —— 宁可 Core 偏好里多一个没人读的键，也不要丢接入清单。
 *
 * 幂等：每一步都以「目标已存在」为出口，所以重复启动不会重复搬、也不会来回搬。
 *
 * @returns 做了什么（给人看的日志行）；没动手时返回空数组
 */
export function migratePluginOwnedData(dataDir: string): string[] {
  const done: string[] = []
  const modelsDir = pluginDataDir(dataDir, 'models')
  const modelsPrefs = join(modelsDir, 'preferences.json')
  const modelsCreds = join(modelsDir, 'credentials.json')
  const corePrefs = join(coreDataDir(dataDir), 'preferences.json')
  const coreCreds = join(coreDataDir(dataDir), 'credentials.json')

  // ── 密钥：复制 → 能读回来 → 删源 ──
  if (!existsSync(modelsCreds) && existsSync(coreCreds)) {
    mkdirSync(modelsDir, { recursive: true })
    try {
      copyFileSync(coreCreds, modelsCreds)
      JSON.parse(readFileSync(modelsCreds, 'utf8'))
      rmSync(coreCreds, { force: true })
      done.push('core/credentials.json -> plugin/models/credentials.json')
    } catch (err) {
      rmSync(modelsCreds, { force: true })
      // 不删源、不静默：这份明文还得有人管，下一次启动再试
      done.push(`WARN: credentials migration failed (${String(err)}) — source kept`)
    }
  }

  // ── 接入清单：从 Core 偏好里摘出 llm 段，写成插件自己的文件 ──
  if (!existsSync(modelsPrefs) && existsSync(corePrefs)) {
    try {
      const parsed = JSON.parse(readFileSync(corePrefs, 'utf8')) as Record<string, unknown>
      const llm = parsed?.llm
      if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
        const src = llm as Record<string, unknown>
        const next = {
          connectedVendors: Array.isArray(src.connectedVendors) ? src.connectedVendors : [],
          vendorOverrides: Array.isArray(src.vendorOverrides) ? src.vendorOverrides : [],
          enabledModels: Array.isArray(src.enabledModels) ? src.enabledModels : [],
        }
        mkdirSync(modelsDir, { recursive: true })
        writeFileSync(modelsPrefs, JSON.stringify(next, null, 2), 'utf8')
        // 写成功了才摘掉 Core 那份（写失败就保持原样，下次再试）
        delete parsed.llm
        writeFileSync(corePrefs, JSON.stringify(parsed, null, 2), 'utf8')
        done.push('core/preferences.json#llm -> plugin/models/preferences.json')
      }
    } catch (err) {
      done.push(`WARN: llm prefs migration failed (${String(err)}) — source kept`)
    }
  }

  return done
}