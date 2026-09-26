# 环境搭建指南（Windows）

本文覆盖在一台全新的 Windows 机器上把 Osteosome 跑起来所需的全部步骤：Node/pnpm、Rust、MSVC Build Tools、WebView2，以及桌面客户端（Tauri 壳）的启动与验证。

只想跑起来的话，按 [1. 环境要求](#1-环境要求) → [2. 安装](#2-安装) → [3. 依赖与构建](#3-依赖与构建) → [4. 启动](#4-启动) 顺序执行即可。遇到报错直接查 [6. 常见问题](#6-常见问题)。

---

## 1. 环境要求

| 组件 | 版本 | 说明 | 自检命令 |
|---|---|---|---|
| Node.js | 24+ | 运行 Core / Vite / 构建脚本 | `node -v` |
| pnpm | 11+（仓库锁定 `pnpm@11.1.2`） | monorepo 包管理，由 Corepack 提供 | `pnpm -v` |
| Rust | stable，target 为 `*-pc-windows-msvc` | 编译 Tauri 桌面壳，提供 `cargo` | `cargo -V` |
| Visual Studio Build Tools | 2022，x64 | 提供 MSVC 链接器与 Windows SDK | 见下方命令 |
| WebView2 Runtime | 最新版 | Tauri 桌面客户端的渲染内核 | 检查「已安装的应用」 |

> 只跑 Web 版（`start-p1b.cmd`）不需要 Rust / MSVC / WebView2；只有 Tauri 桌面客户端需要。

## 2. 安装

### 2.1 Node.js 与 pnpm

从 [nodejs.org](https://nodejs.org/) 安装 Node.js 24 或更高版本，然后启用 Corepack 自带的 pnpm：

```powershell
corepack enable pnpm
corepack prepare pnpm@11.1.2 --activate
```

仓库根 `package.json` 里声明了 `"packageManager": "pnpm@11.1.2"`，Corepack 会在进入仓库时自动对齐该版本。

验证：

```powershell
node -v
pnpm -v
where.exe pnpm.cmd
```

### 2.2 Rust（stable-msvc）

```powershell
winget install --id Rustlang.Rustup -e
```

或从 [rustup.rs](https://rustup.rs/) 下载安装。安装时选默认的 `stable-x86_64-pc-windows-msvc` 工具链即可（Windows 上 `stable` 默认就是 MSVC target）。

验证（**必须新开一个终端**，安装程序写入的 PATH 只有新进程才能看到）：

```powershell
cargo -V
rustc -V
where.exe cargo
```

`cargo` 应位于 `%USERPROFILE%\.cargo\bin`。如果提示找不到命令，说明当前终端是在装 Rust 之前打开的，关掉重开即可。

### 2.3 Visual Studio 2022 Build Tools

装 **Build Tools** 即可，不需要完整的 IDE。必须包含两个组件，缺一个都会在编译 Tauri 壳时报错：

- `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` —— MSVC 编译器与链接器（`cl.exe` / `link.exe`）
- `Microsoft.VisualStudio.Workload.VCTools` 里的 Windows 10/11 SDK —— 提供 `kernel32.lib` 等系统库

命令行安装（自动完成，无需点选）：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--quiet --wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

验证（需要能输出安装路径）：

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
  -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
```

期望输出类似：

```text
C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
```

仓库里的启动脚本（`start-client.cmd` / `run-tauri-dev.cmd` / `build-tauri-msvc.cmd`）都是用 `vswhere` 找到该路径，再调用 `VC\Auxiliary\Build\vcvarsall.bat x64` 注入 MSVC 环境，**所以用这些脚本时不需要手动开「x64 Native Tools 命令行」**。

### 2.4 WebView2 Runtime

Windows 11 与较新的 Windows 10 已预装。确认「设置 → 应用 → 已安装的应用」里存在 `Microsoft Edge WebView2 Runtime`；缺失时从 [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) 下载安装。

## 3. 依赖与构建

在仓库根目录执行：

```powershell
pnpm install
pnpm build
```

- `pnpm install` 会安装全部 workspace 依赖，其中包含 `src-tauri` 需要的 `@tauri-apps/cli`。
- `pnpm build` 会依次构建 `shared` / `core` / `sdk` / `services/*` / `client`；客户端产物输出到 `core/dist/client`。
- Tauri 桌面壳**不在这一步编译**，首次 `start-client.cmd` 时由 `tauri dev` 增量编译（第一次会编译几分钟，之后只重编改动的部分，产物缓存在 `src-tauri/target/`）。

只构建、不含 Tauri 时也可以显式排除：

```powershell
pnpm -r --filter "!@osteosome/tauri-app" run build
```

## 4. 启动

仓库根目录有四个启动脚本，按场景选：

| 脚本 | 场景 | 行为 |
|---|---|---|
| `start-client.cmd` | **桌面客户端**（日常开发主用） | 启动 Core（`127.0.0.1:1420`）→ Vite（`127.0.0.1:5173`）→ 打开 Tauri 原生客户端窗口加载 `localhost:5173`；前端改动 HMR 自动刷新，Core 改动只需重启 Core 窗口 |
| `start-p1b.cmd` | Web 版 / 不想装 Rust | 先 `pnpm build`，再启动 Core 与 Vite，并用默认浏览器打开 `http://127.0.0.1:5173/` |
| `run-tauri-dev.cmd` | 只调试 Tauri 壳 | 在 `src-tauri/` 内执行 `tauri dev`（需 Core、Vite 已在运行） |
| `build-tauri-msvc.cmd` | 产出可执行文件 | 执行 `tauri build --no-bundle`，结果在 `src-tauri/target/release/` |

推荐流程：

```powershell
pnpm install
pnpm build
.\start-client.cmd
```

`start-client.cmd` 会依次打开三个窗口（Core / Vite / Client），并逐个等待对应端口就绪，任一环节失败会停在 `pause` 处并打印 `[client] ERROR: ...`。**关闭这三个窗口即停止全部服务。**

注意这几个 `.cmd` 脚本必须保持 **ASCII-only**：cmd.exe 用系统 ANSI 代码页解析批处理，混进 UTF-8 中文会让括号、引号错位。

## 5. 确认启动成功

三个都满足即为正常：

```powershell
# 1) Core 存活：返回 {"ok":true,...}
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:1420/health | Select-Object -ExpandProperty Content

# 2) Vite 可访问：HTTP 200，页面 title 为 Osteosome
(Invoke-WebRequest -UseBasicParsing http://localhost:5173/).StatusCode

# 3) 桌面客户端进程存在，且窗口标题为 Osteosome
Get-Process osteosome | Select-Object Id, ProcessName, MainWindowTitle
```

Tauri 的 `devUrl` 配的是 `http://localhost:5173`，而 Vite 绑在 `127.0.0.1`；若本机 `localhost` 优先解析到 `::1`，客户端会一直停在 `Waiting for your frontend dev server to start on http://localhost:5173/...`。遇到时改用 IPv4 解析或在 `vite.config` 里显式设置 `host: 'localhost'`。

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `[client] ERROR: cargo / Rust was not found in PATH.` | 终端在装 Rust 之前就打开着，没继承新 PATH | 关掉重开终端；或 `set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"` |
| `error: linker 'link.exe' not found` | 当前 shell 没有 MSVC 环境 | 用 `start-client.cmd` / `run-tauri-dev.cmd`（内部会调 `vcvarsall`），或手动执行 `vcvarsall.bat x64` |
| `LNK1181: cannot open kernel32.lib` | 装了 MSVC 但没装 Windows SDK | 用 `--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended` 补装 SDK |
| `vswhere` 查不到任何安装路径 | COM 组件 `Microsoft.VisualStudio.Setup.Configuration.Native.dll` 缺失（VS 安装被裁剪/清理过），注册表项还在但文件没了 | 用 VS Installer 执行「修复」；确认 `C:\ProgramData\Microsoft\VisualStudio\Setup\x64\` 与 `x86\` 下有该 DLL |
| `此时不应有 \Microsoft。` | 批处理在 `if (...)` 块里 `echo` 了含 `(x86)` 的路径，右括号提前闭合了代码块 | 路径改在块外 `echo`（`start-client.cmd` 已按此修复，改脚本时注意同类写法） |
| Vite 报 `错误: 不支持输入重定向` | 启动 Vite 时把 stdin 重定向到了非 TTY（如 `< NUL`） | 交互式窗口直接启动；自动化脚本里不要重定向 Vite 的 stdin |
| `ERROR: port 1420 / 5173 is already in use` | 上一次的 Core 或 Vite 还在跑 | 关掉对应窗口，或 `Get-NetTCPConnection -LocalPort 1420,5173` 找到 PID 后结束 |
| 客户端窗口空白 / 一直转圈 | Vite 没起来，或端口被别的进程占用 | 先确认 `http://localhost:5173/` 能返回 200，再看 Client 窗口里的报错 |

## 7. 清理构建缓存

Tauri / Rust 的编译缓存位于 `src-tauri/target/`，含依赖、调试符号与增量数据，可能占用数 GB（已由 `.gitignore` 排除）。停掉所有 Tauri / Cargo 进程后可安全删除，下次构建自动重建：

```powershell
Get-Process cargo,osteosome -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .\src-tauri\target
```

Core 的本地运行数据在 `.data/`（同样已忽略），删掉即回到全新状态。

## 8. 环境自检清单

新机器或重装系统后，按顺序执行，全部通过即可开工：

```powershell
node -v                  # >= v24
pnpm -v                  # 11.x
cargo -V                 # 能输出版本（PATH 里有 .cargo\bin）
rustc -V
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
  -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath   # 能输出 BuildTools 路径
Test-Path "${env:ProgramFiles(x86)}\Windows Kits\10\Lib"   # Windows SDK 存在
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue   # WebView2
```

---

## 相关文档

- [`README.md`](./README.md) —— 项目总览、架构哲学与功能清单
- [`docs/ost-开发文档.md`](./docs/ost-开发文档.md) —— 插件化架构 RFC
- [`docs/前端工作台-现行实现.md`](./docs/前端工作台-现行实现.md) —— 工作台现行实现说明
- [`docs/开发进度/阶段追踪.md`](./docs/开发进度/阶段追踪.md) —— 里程碑进度追踪
