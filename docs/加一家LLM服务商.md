# 加一家 LLM 服务商

分两种情况，**先判断是哪一种** —— 走错路会做出一个「声称支持、实际发错请求体」的假 provider。

```
这家商的请求体 / 鉴权头 / 传输方式，是 openai 兼容的吗？
（POST {base}/chat/completions，body{model,messages,stream:true}，SSE data:{choices:[{delta}]}）
│
├─ 是 ──────────────────────→ 情况 A：加一行（改 1 个文件）
└─ 否 ──────────────────────→ 情况 B：加一个进程 + 一个插件（改 3 处 + 1 个新目录）
```

---

## 情况 A：openai 兼容 → 加一行

只改 `shared/src/llm/vendors.ts` 的 `VENDOR_PRESETS`：

```ts
{
  id: 'acme',                        // 注册到主位路由表的名字，slug
  label: 'ACME',
  baseUrl: 'https://api.acme.com/v1',// 含 /v1，不含 /chat/completions
  api: WIRE_OPENAI,                  // ← wire 契约：谁实现这个 wire
  credentialEnv: 'ACME_API_KEY',     // 凭证 env 名；空串 = 免凭证
  defaultModel: 'acme-1',
  models: ['acme-1'],                // 静态兜底目录（/models 拉不到时用）
  note: '可选，展示在设置窗',
}
```

**就这样。不用加代码，不用加进程，不用加测试。**

立刻生效的机制：
- 配了 `ACME_API_KEY` → `llm-provider-openai` 启动时注册 `acme` → 前端下拉出现 → 可选中
- 没配 → **不注册** → 下拉里没有它 → 指定它发问得 `unsupported_provider`

顺手可用的 env 覆盖（不用改表）：`ACME_BASE_URL` 改端点、`ACME_MODEL` 改默认模型。

自建端点 / 私有代理连改表都不用，走 `LLM_VENDORS_EXTRA`（JSON 数组，S3 会换成设置窗）：

```bash
LLM_VENDORS_EXTRA='[{"id":"my-proxy","baseUrl":"http://127.0.0.1:8080/v1","defaultModel":"x"}]'
```

---

## 情况 B：wire 完全不同 → 加一个进程 + 一个插件

比如 `opencode` 的请求体结构和 openai 没有任何共同点。这时**不要**往 `VENDOR_PRESETS` 填一行了事 —— 那是声明，不是实现。

### 为什么不能只加一行

`api` 字段是**跨进程契约**，不是协议标签：

> wire `X` 约定由服务 `llm-provider-X` 实现。

`llm-provider-openai` 进程**兑现不了自己声明不了的东西**。硬塞一行 `api: 'opencode'` 进去，本进程要么注册出一个声称支持实际发错 body 的假 provider，要么悄悄忽略让你以为装上了。两种都是坏果。

这条不变量由 `shared/tests/vendor-wires.test.ts` 在 CI 里挡：
「预设表声明的每个 wire，都必须存在 `services/llm-provider-<wire>/service.json`」——缺了就在 CI 红，不留到运行时。

### 四步

**1. 新建进程目录** `services/llm-provider-opencode/`

```
services/llm-provider-opencode/
  package.json          # 抄 llm-provider-openai 的，改 name / id
  service.json          # 抄一份，id 改 llm-provider-opencode
  tsconfig.json
  tsconfig.build.json
  src/index.ts          # 装配层：注册 / 路由 / 模型目录
  src/provider.ts       # ★ 唯一真正要写的：wire 翻译
  tests/provider.test.ts
```

**2. 写 `src/provider.ts`** —— 这是全部工作量所在。骨架照抄 openai 那份，只换三处：

```ts
export const RETRY_POLICY: RetryPolicy = { /* 这家的错误语义，可能与 openai 不同 */ }
export const STATIC_MODELS = ['oc-1']   // 不提供 /models 就填静态兜底

export async function* streamCompletions(req: StreamRequest): AsyncGenerator<StreamChunk> {
  // ① 请求体：按 opencode 的格式拼（这里就是「完全不同」的地方）
  // ② 传输：解析成 StreamChunk（block-start / delta / tool-arg-delta / block-end / finish）
  // ③ finishReason 归一：把 opencode 的原始值映射到中立枚举
  //    → 用 shared 的 normalizeFinishReason，未知值一律归 stop
}
```

**唯一不能改的是中立契约 `StreamChunk`**（`shared/src/llm/types.ts`）。它是所有 provider 之间的接口 —— 改它就要动 `llm` 主位、`loop` 和前端，那正是这个设计要避免的。

**3. 在预设表里声明**

```ts
{
  id: 'opencode',
  label: 'OpenCode',
  baseUrl: 'https://api.opencode.ai/v1',
  api: 'opencode',          // ← 指向新进程；CI 会校验 services/llm-provider-opencode 存在
  credentialEnv: 'OPENCODE_API_KEY',
  defaultModel: 'oc-1',
  models: ['oc-1'],
}
```

同时在 `src/instances.ts` 里让 `SERVED_WIRE = 'opencode'`（`buildVendorInstances` 已按 wire 过滤，不用改逻辑）。

**4. 写 `plugins/llm-provider-opencode/plugin.json`**（插件体系落地后；在此之前 Core 会自动发现该服务并启动）

```json
{
  "id": "llm-provider-opencode",
  "name": "OpenCode 接入",
  "services": ["llm-provider-opencode"],
  "components": ["widget.llm-providers"],
  "dependencies": [{ "pluginId": "credentials", "optional": true }]
}
```

### 哪些代码不用改

`llm` 主位、`loop`、前端**一行都不用动**。原因是 `llm` 的路由表只认名字：

```ts
// services/llm/src/routes.ts
const routes = new Map<string, ProviderRoute>()   // key 只是 provider 名
```

`llm/src/index.ts` 第 2 行就写着「**不 import 任何 provider 实现**」。所以：
- 注册事件一发出去，前端下拉自动多一家（下拉是 `llm.provider.registered` 驱动的）
- 请求按 `payload.provider` 路由到你的进程
- 主位把你的 `llm.provider.chunk` 翻译成 `llm.token.streamed` / `llm.request.finished`

**这就是「加一家厂商」在两个层面上都是真的：openai 兼容的加一行，wire 不同的加一个进程 —— 两者都不需要碰主位。**

---

## 常见误区

| 误区 | 后果 |
|---|---|
| 往 `VENDOR_PRESETS` 填一行 `api: 'opencode'` 就完事 | CI 挂（`vendor-wires.test.ts`）。这是**故意的** —— 别绕过它 |
| 复用 `llm-provider-openai` 进程处理新 wire | 主位会路由过来，但请求体是错的，用户拿到莫名 400 且查不出根因 |
| 直接透传厂商的原始 `finish_reason` 给前端 | 破坏中立枚举。必须过 `normalizeFinishReason`，未知值归 `stop` |
| 自填端点填了别家 `api` 后以为装上了 | 现在会**告警并跳过**（`registerCapabilities` 打印原因），不会静默 |
| 以为「配了 key 就等于装了插件」 | 那是**厂商级**粒度（凭证决定）。**进程级**粒度由插件决定 —— 停掉 provider 插件会停掉它内部**所有**厂商 |

## 相关文件

| 文件 | 作用 |
|---|---|
| `shared/src/llm/vendors.ts` | 预设表 + wire 契约（`WIRE_OPENAI` / `providerServiceIdForWire` / `presetsForWire`） |
| `shared/src/llm/types.ts` | 中立契约 `StreamChunk` / `ProviderDescriptor` / `RetryPolicy` —— **provider 之间唯一的接口** |
| `shared/tests/vendor-wires.test.ts` | CI 不变量：声明的 wire 必须有进程兑现 |
| `services/llm-provider-openai/src/instances.ts` | `buildVendorInstances`（按 wire 过滤 + 拒绝别家 wire 的自填项） |
| `services/llm-provider-openai/src/provider.ts` | openai 兼容 wire 翻译（情况 B 的抄写模板） |
| `services/llm/src/routes.ts` | 主位路由表（`Map<provider 名, 描述>`，不 import 任何实现） |
