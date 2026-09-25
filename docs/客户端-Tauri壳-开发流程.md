# 客户端（Tauri 壳）开发流程
> 定位：Osteosome 是客户端优先的产品，**不做 webui**（webui 仅作开发/调试 fallback）。
> 目标：**壳(Tauri)打一次，以后前端/后端改完直接跑客户端，不重复打包壳。**

## 1. 三层结构回顾

```
┌─ Tauri 壳（Rust）──────────────────────────┐
│  开主窗口 · 外部原生窗口(插件管理) · 托盘    │
│  快捷键 · 系统集成                          │
│  加载 localhost:5173 (Vue 前端)             │
│  ❌ 不做文件 / AI / 业务                    │
└──────────────────┬─────────────────────────┘
                   │ HTTP / SSE (127.0.0.1:1420)
┌──────────────────▼─────────────────────────┐
│  Node Core（龙骨 · 一切业务）               │
│  文件 · 命令 · 会话 · 记忆 · MCP · 装配     │
│  凭证 · 事件总线                            │
└───────┬──────────────────────────┬─────────┘
        │                          │
  远程 LLM 服务商              本地推理(可选)
  deepseek/openai              Ollama/llama.cpp
```

## 2. 壳加载前端的方式

| 模式 | 前端来源 | 用途 |
|---|---|---|
| `tauri dev` | http://localhost:5173（Vite dev） | **日常开发** |
| `tauri build` | 打包静态文件进壳（`frontendDist`） | 正式发版 |

关键点：
- **开发时壳加载 5173**，前端 HMR 即时刷新，壳零改动。
- **发版时**前端才被打进壳里，需重新 `tauri build` 一次出安装包。

## 3. 日常开发节奏（壳打一次，前端/后端随便改）

| 你改什么 | 要做什么 | 壳是否重建 |
|---|---|---|
| 前端（Vue） | 无需操作，Vite HMR 自刷 | 否 |
| 后端（Core） | 重启 Core 进程窗口 | 否 |
| 壳（Rust） | `tauri dev` 增量重编译壳 | 是（仅改壳才需要） |

**结论**：壳(Rust)几乎写一次不动。`tauri dev` 只要壳代码没变就复用增量缓存，启动快，不重复打包。

## 4. 一键启动脚本

仓库根目录提供 `start-client.cmd`：

```powershell
.\start-client.cmd
```

脚本流程：
1. 启动 **Core**（node, 127.0.0.1:1420）
2. 等待 Core ready
3. 启动 **Vite dev**（127.0.0.1:5173）
4. 等待 Vite ready
5. 检测 MSVC 环境（vswhere → vcvarsall）并注入
6. 启动 **Tauri dev**（`pnpm --filter @osteosome/tauri-app tauri dev`，打开客户端原生窗口，加载 5173）
7. 若 `src-tauri/` 尚未脚手架 → **webui fallback**（仅开发调试，打开浏览器 5173）

## 5. Tauri 壳（已初始化）

当前仓库已含 `src-tauri/`：

```
src-tauri/
├── Cargo.toml          # tauri 2 + tray-icon + opener
├── tauri.conf.json     # devUrl=localhost:5173, frontendDist=../core/dist/client
├── build.rs
├── capabilities/default.json
├── icons/              # 32/128/icon.icns/icon.ico（占位品牌图，可替换）
├── package.json        # @osteosome/tauri-app，提供 tauri dev/build
└── src/
    ├── main.rs
    └── lib.rs          # 壳极薄：只开窗口/浮窗/托盘/快捷键
```

> 注意：client 的 Vite `build.outDir` 是 `../core/dist/client`，所以
> **`frontendDist` 必须指向 `../core/dist/client`**（不是 `../client/dist`）。

## 6. Windows 前置（一次性，首次编译必需）

Tauri 在 Windows 需要 **MSVC 工具链 + Windows SDK** 才能编译原生壳：

- Rust：`winget install Rustlang.Rustup` → `rustup default stable-msvc`
- **Visual Studio 2022** 安装两个组件（关键，缺一个都会编译失败）：
  - **C++ 桌面开发** → `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
  - **Windows 10 SDK** → `Microsoft.VisualStudio.Component.Windows10SDK.19041`
- 缺 Windows SDK 时典型报错：`LNK1181: 无法打开输入文件 kernel32.lib`

`start-client.cmd` 会自动用 `vswhere` 定位 VS 并 `vcvarsall` 注入环境；若检测不到会打印安装提示。

## 7. 客户端才有的能力（webui 无法替代）

这些体验**只有客户端原生窗口能真实提供**，所以开发要直接跑客户端：

- **插件管理 = 外部原生独立窗口**，可拖出主窗口边界、多屏、最小化
- **跨窗口装配**：从插件管理窗口把组件拖到主窗口 Panel
- **托盘 / 全局快捷键 / 系统集成**
- 窗口行为（置顶、缩放、原生标题栏）

## 8. 为什么不做 webui

- 客户端优先：Osteosome 从始至终是客户端形态。
- webui 仅作**开发调试 fallback**（`start-client.cmd` 在壳未脚手架时兜底用）。
- 重复打包客户端的问题已由「壳打一次 + tauri dev 增量」解决，不必依赖 webui。

---

*相关：docs/wireframes/index.html（线框）、README.md（架构）。*
