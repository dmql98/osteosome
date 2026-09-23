# Osteosome

<p align="center"><b>一切皆插件的本地桌面 AI 智能体壳 —— 龙骨(引擎)小而稳,血肉(插件)皆可拔</b></p>

> 原名 **天枢（TianShu）**,2.0 更名与插件化重构中。"Osteosome" 取骨结构单元之意:骨架负责承重与连接,血肉（角色、技能、工具、服务商、界面面板）以插件形式长在骨上。
>
> ⚠️ 本仓库当前处于建仓起步阶段,仅含设计文档;源码与构建产物将陆续从天枢仓库迁移。

---

## 这是什么

Osteosome 是一个**本地运行**的桌面 AI 智能体壳。**它的特色不是某个功能,而是"一切皆插件"本身**:引擎（龙骨）保持精简——装配清单、事件扩展点、`ctx` 上下文、Pane 工作台底座——其余能力都以"血肉"插件的形态长在骨上,可单独安装、卸载、替换。

它不只提供对话,还允许 Agent 读取项目、调用工具、执行命令、委托子 Agent、管理长期目标。**多角色人格助手**是继承自天枢的默认血肉:**出厂自带、开箱即用,但用户完全可以卸载它**——把它换成单一角色、一个工具壳或任何别的形态;角色不是架构核心,插件才是。

## 名字的由来

命名基于一个比喻:**引擎是龙骨,插件是血肉**。

- **龙骨（Osteosome 骨架）** —— 一个保持精简、有主见的引擎:装配清单、事件扩展点、`ctx` 上下文、Pane 工作台底座。
- **血肉（插件）** —— 角色、技能包、工具管线、模型服务商适配器、UI 面板,全部可插拔、可替换、可长回原位。

配套词汇:鳞 = 主题、爪 = 工具、心跳 = 事件流、髓 = 记忆。

## 架构哲学:一切皆插件

以 DeepSeek Harness「Everything is a Plugin」为纲,对现有的三个"焊线点"（`app.ts` / `outer.ts` / `loop-engine.ts`）做 **5 层 strangler** 式耦合治理:小步执行、每步全绿、每层可独立 revert。

- **A 组·契约对齐**（落地顺序）:**④ LLM 适配器契约** → **③ 工具管线** → **① 会话事件化** → **② Compaction**
- **B 组·相当不动**:skills / goal / plan / 子代理抽象
- **前端工作台化**:Pane 即窗口 —— 写一个 `definePane`,就得到一个可停靠、可拉出成独立窗口的界面单元;布局为可序列化 JSON。

详见文档:

| 文档 | 内容 |
|---|---|
| [`docs/ost-开发文档.md`](./docs/ost-开发文档.md) | 插件化架构 RFC(动机 / 目标架构 / 扩展点 / 接缝 / 迁移路线 / 不变式 / 边界 / 对标 dsh / 工作台 / 服务商问题清单) |
| [`docs/ost-开发文档.html`](./docs/ost-开发文档.html) | 同内容的可视化汇报版 |
| [`docs/开发进度/阶段追踪.md`](./docs/开发进度/阶段追踪.md) | 里程碑 P1-P8 进度追踪（修订路线图落地，自 2026-09-23 起维护） |
| [`docs/开发进度/P1a-详细计划.md`](./docs/开发进度/P1a-详细计划.md) | P1a 里程碑详细计划（工作分解 WS-1~7 / 测试矩阵 / 绿灯标准 / 两处小补强附录） |
| [`docs/开发进度/P1b-详细计划.md`](./docs/开发进度/P1b-详细计划.md) | P1b 里程碑详细计划（Pane 工作台骨架 WS-1~6 + WS-1b 组件库 / 接口定案 / 绿灯标准） |
| [`docs/开发进度/P2-详细计划.md`](./docs/开发进度/P2-详细计划.md) | P2 里程碑详细计划（DSH 接缝三角：LlmAdapter / StreamChunk / 凭证引用 / retry 声明 + deepseek 单实现） |
| [`docs/开发进度/P3-详细计划.md`](./docs/开发进度/P3-详细计划.md) | P3 里程碑详细计划（会话存储 + 会话列表 Pane + Loop 编排 + 命令/结果 IPC） |
| [`docs/开发进度/P4-详细计划.md`](./docs/开发进度/P4-详细计划.md) | P4 里程碑详细计划（凭证 seam + 三 provider + 模型目录 + retry 执行器 + 设置 Pane） |
| [`docs/core-modules.svg`](./docs/core-modules.svg) | Core 模块依赖图（`core开发文档.md` §1.3 引用） |

## 主要功能

> 以下多数条目的定位是**默认自带的血肉插件**:开箱即用,也可以单独卸载或替换。

- **插件即特色**:引擎之外的任何能力——角色、技能包、工具管线、模型服务商、UI 面板——都是插件;统一插件契约（装配清单 + 事件扩展点 + `ctx`）,可安装 / 卸载 / 替换,卸载后布局与运行不崩,重装原位复原。
- **Agent 会话**:流式回复、思考内容、工具执行过程、Token 用量与生成速度;支持从回复创建分支会话。
- **轨迹（Trajectory）**:会话内观察窗,行级时间线 + 指标 + 实时过程。
- **角色系统（默认插件,可卸载）**:人格（Soul / User / Memory）、模型、工具、技能、头像与角色资源;角色可独立绑定技能与工具。
- **技能包**:内置设计、图表、金融、玄学、专利等技能包,按需懒加载。
- **执行与运行策略**:只读 / 风险确认 / 自动批准;系统安全策略 + 角色偏好 + Run 策略快照三层防护,支持自动续跑与动态收敛。
- **子 Agent 与目标规划**:委托子任务独立上下文执行;Direct / Plan-first / Goal 三种执行模式。
- **工具系统与 MCP**:文件读写、命令执行、搜索、网页访问;接入外部 MCP Server（支持检测本机 MCP、导入 JSON 配置）。
- **事件系统**:一次性任务、定时任务、事件执行会话。
- **主题系统**:浅色 / 深色 / 跟随系统;上传图片自动取色生成自定义主题。
- **服务商适配**:多模型服务商,统一 OpenAI 兼容 `wire`(契约对齐改造中,见文档 §12 问题清单)。
- **本地数据**:会话、角色、配置、运行数据全部保存在用户指定目录。

## 技术栈

- **客户端**:Electron + React（Vite）;Pane 工作台(Hono 桥 / PaneHost / BroadcastChannel 跨窗同步)。
- **服务端**:Node.js + TypeScript,Hono / Socket.IO(见天枢仓 `dev/web/server`）。
- **存储**:本地数据库与文件,本地优先,运行轨迹可 git 快照。

## 仓库布局(规划)

```
osteosome/
├── docs/                     # 设计文档：架构 RFC / Core RFC / 里程碑追踪 / 模块图
├── web/server                # 服务端(待迁移)
├── web/client                # React 客户端(待迁移)
├── desktop                   # Electron 壳与打包(待迁移)
└── content/builtin           # 内置内容(角色/技能/服务商预设)(待迁移)
```

## 开发(源码迁移前见天枢仓)

```powershell
cd dev
npm ci --prefix web/server
npm ci --prefix web/client
npm ci --prefix desktop
npm run dev
```

依赖管理:

- `npm run build` —— 构建 server + client + desktop
- `npm run dev` —— 启动 Hono/Socket.IO(:3456)、Vite(:3457) 并打开 Electron 窗口
- `npm run test:server` / `npm run test:desktop` —— 服务端 / 桌面冒烟测试
- `npm run dist:*` —— 各平台打包(win / mac:x64 / mac:arm64 / linux:x64)

> 任何重构以"每步绿灯"为门槛:`npm test --prefix web/server` 全绿 → `npm run build --prefix web/server` 通过。

## License

Apache-2.0