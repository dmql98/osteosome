<script setup lang="ts">
/**
 * OpenAI 兼容端点 —— 模型配置页的第三块（原「自定义端点」，改名对齐用户叫法）。
 *
 * ## 它和「服务商」的区别（这是最容易混的地方）
 *
 * · **服务商** = 12 家预设，开箱带 baseUrl；改端点等于「覆盖预设」，会打「已覆盖预设」标记
 * · **OpenAI 兼容端点** = **不在预设里**的地址（内网网关、别人的 vLLM、代理……）
 *
 * 所以这个区**过滤掉了所有预设 id**：那些在上面的卡片里改完就生效了，
 * 在这儿再列一遍会让同一个端点出现在两个地方、两处配置。
 *
 * ## 每一行为什么能展开
 *
 * 之前这一块只有「探测 / 编辑 / 删除」三个按钮：探测能拿到模型，但**界面里没有地方放**，
 * 于是用户点完只看到一个绿色的点，仍然不知道这个端点上有哪些模型、默认走哪个、
 * 哪些不想要。预设卡片有模型墙，自建端点反而没有 —— 而自建端点恰恰是最需要挑模型的
 * （本地 vLLM / 网关一次几十个，大部分不能用）。
 *
 * 现在与预设卡片对齐（参考 dsh 的设置-模型 页）：
 * 头行扫完状态，身体是「默认模型 + 模型墙」，墙上能设默认、能逐个启停。
 *
 * ## 「获取模型列表」= 探测 + 采纳
 *
 * 探测（`llm.models.list`）只把清单放进**内存**，进程一重启就空。所以拆成两步：
 * 「获取模型列表」拉到候选 → 弹窗里勾选 → **采纳进配置**（`vendorOverrides[].models`）。
 * 落盘的那份同时是 owner 的静态兜底（`staticModels`），于是重启后、或端点一时连不上时，
 * 对话输入框的下拉里仍然是这份清单。
 *
 * 「编辑清单」是同一张弹窗的另一条入口：**不联网**，改的是已采纳的那份 ——
 * 端点挂了的时候也有地方删掉不要的模型名、或手填一个新的。
 *
 * ## ⚠️ 文件头不要放 JS 块注释
 *
 * Vue 的 SFC 解析器把 `<script>` **之前**的内容按 HTML 解析，
 * 注释里出现 `<dl>` 这类尖括号会被当成顶层标签，报 `Element is missing end tag`
 * 且位置完全不指向真因。所以注释一律写在 `<script>` 内部。
 */
import { computed } from 'vue'
import { Button } from '@osteosome/ui'
import { IconButton } from '@osteosome/ui'
import { Input } from '@osteosome/ui'
import type { ModelProfile } from '@osteosome/shared'
import ModelWall from './ModelWall.vue'

export interface EndpointRow {
  id: string
  label: string
  baseUrl: string
  /**
   * 要不要密钥。
   *
   * `credentialRef: ''` = 显式免凭证；**字段缺省 = 要密钥**（由 provider 去
   * env / 本插件凭证文件按端点 id 找，找不到就不注册）。
   * 不能用「字符串是否为空」在展示层推断，所以视图层先算成布尔。
   */
  needsKey: boolean
  /** 生效的模型清单：探测结果优先；没探过 / 探不到时用已采纳的那份 */
  models: string[]
  /** 已采纳进配置的条数（0 = 只有探测清单，重启后会空） */
  configuredCount: number
  /** 本端点下已禁用的模型名 */
  disabled: string[]
  /** 模型名 → 能力（本端点作用域，键不带 provider 前缀） */
  profiles: Record<string, ModelProfile>
  /** 当前生效的默认模型 */
  defaultModel: string
  /** `null` = 还没探过（与「探过了连不上」要分开显示） */
  catalog: 'remote' | 'static' | null
  expanded: boolean
}

const props = defineProps<{
  endpoints: EndpointRow[]
  probing: Record<string, boolean>
  /** 页头搜索词 —— 透传给模型墙做模型名过滤 */
  query: string
}>()

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'edit', endpointId: string): void
  (e: 'remove', endpointId: string): void
  (e: 'toggle', endpointId: string): void
  /** 拉一次上游清单并打开采纳弹窗（会发 `llm.models.list`） */
  (e: 'fetch', endpointId: string): void
  /** 只打开采纳弹窗，不联网（改已采纳的那份） */
  (e: 'pick', endpointId: string): void
  (e: 'edit-model', endpointId: string, value: string): void
  (e: 'set-default', endpointId: string, model: string): void
  (e: 'toggle-model', endpointId: string, model: string, on: boolean): void
  (e: 'set-all', endpointId: string, on: boolean): void
  /** 模型级能力（上下文 / 输出 / 输入模态 / 思考档位） */
  (e: 'update-profile', endpointId: string, model: string, profile: ModelProfile): void
}>()

function stateDot(e: EndpointRow): string {
  if (e.catalog === 'remote') return 'green'
  if (e.catalog === 'static') return 'red'
  return 'gray'
}

function statusText(e: EndpointRow): string {
  if (props.probing[e.id]) return '探测中…'
  if (e.catalog === null) return '未测试'
  return e.catalog === 'remote' ? '已连通' : '连不上 · 无上游清单'
}

/** 清单出处一句话 —— 「重启后还在不在」是这一步真正的区别 */
function catalogSourceText(e: EndpointRow): string {
  if (e.configuredCount > 0) return `已采纳 ${e.configuredCount} 条（重启后仍可用）`
  return '只在探测结果里，重启后会空'
}

/** 未启用模型数：全部禁用按钮点了没变化时不该给假反馈 */
const offCount = computed(() => {
  const out: Record<string, number> = {}
  for (const e of props.endpoints) out[e.id] = e.disabled.length
  return out
})

/**
 * 模型墙的监听器。
 *
 * 用 `v-on="object"` 而不是逐个写内联语句：模板内联**只能拿到第一个参数**（`$event`），
 * 而 `toggle` 要传 `(model, on)` 两个 —— 内联写法会静默丢掉 `on`，
 * 症状是开关永远只往一边翻。同 `VendorListSection.cardListeners` 的处置。
 */
function wallListeners(id: string) {
  return {
    setDefault: (model: string) => emit('set-default', id, model),
    toggle: (model: string, on: boolean) => emit('toggle-model', id, model, on),
    updateProfile: (model: string, profile: ModelProfile) => emit('update-profile', id, model, profile),
  }
}
</script>

<template>
  <section class="endpoints">
    <header class="endpoints__head">
      <h3 class="endpoints__title">OpenAI 兼容端点 ({{ endpoints.length }})</h3>
    </header>
    <p class="endpoints__hint">
      不在预设里的地址：内网网关、别人的 vLLM、代理…… 预设厂商改端点请去上面的卡片。
    </p>

    <button type="button" class="endpoints__add" data-testid="endpoint-new" @click="emit('create')">
      ＋ 新增 OpenAI 兼容端点
    </button>

    <p v-if="!endpoints.length" class="endpoints__empty">
      还没有 OpenAI 兼容端点 —— 用上面的按钮加一个（内网网关 / 别人的 vLLM / 代理）。
    </p>

    <div
      v-for="e in endpoints"
      :key="e.id"
      class="endpoint"
      :class="{ 'endpoint--open': e.expanded }"
      :data-testid="`endpoint-${e.id}`"
    >
      <div class="endpoint__head">
        <button
          type="button"
          class="endpoint__toggle"
          :aria-expanded="e.expanded ? 'true' : 'false'"
          @click="emit('toggle', e.id)"
        >
          <span class="dot" :class="stateDot(e)" />
          <span class="endpoint__name">{{ e.label || e.id }}</span>
          <span class="endpoint__url mono">{{ e.baseUrl }}</span>
          <span class="endpoint__count">{{ e.models.length }} 个模型</span>
          <span class="endpoint__status" :class="`is-${e.catalog ?? 'idle'}`">{{ statusText(e) }}</span>
          <span class="endpoint__cred" :class="{ 'endpoint__cred--need': e.needsKey }">
            {{ e.needsKey ? '需要密钥' : '免凭证' }}
          </span>
          <span class="endpoint__chev" aria-hidden="true">{{ e.expanded ? '▾' : '▸' }}</span>
        </button>
        <div class="endpoint__actions">
          <Button
            size="sm"
            variant="ghost"
            :disabled="probing[e.id]"
            :data-testid="`ep-fetch-${e.id}`"
            @click="emit('fetch', e.id)"
          >
            {{ probing[e.id] ? '拉取中…' : '获取模型列表' }}
          </Button>
          <Button size="sm" variant="ghost" :data-testid="`ep-edit-${e.id}`" @click="emit('edit', e.id)">编辑</Button>
          <IconButton icon="✕" label="删除" @click="emit('remove', e.id)" />
        </div>
      </div>

      <div v-show="e.expanded" class="endpoint__body">
        <div class="field">
          <span class="field__key">默认</span>
          <Input
            class="field__input mono"
            :model-value="e.defaultModel"
            placeholder="这个端点由你决定模型名"
            :data-testid="`ep-model-${e.id}`"
            @update:model-value="emit('edit-model', e.id, String($event))"
          />
          <span class="field__hint">对话框没选模型时用它</span>
        </div>

        <div class="wall-head">
          <span class="wall-head__title">可用模型 ({{ e.models.length }})</span>
          <span class="wall-head__src">{{ catalogSourceText(e) }}</span>
          <Button size="sm" variant="ghost" :data-testid="`ep-pick-${e.id}`" @click="emit('pick', e.id)">
            编辑清单
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :data-testid="`ep-all-on-${e.id}`"
            @click="emit('set-all', e.id, true)"
          >
            全部启用
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :disabled="!offCount[e.id]"
            :data-testid="`ep-all-off-${e.id}`"
            @click="emit('set-all', e.id, false)"
          >
            全部禁用
          </Button>
        </div>

        <ModelWall
          v-on="wallListeners(e.id)"
          :models="e.models"
          :disabled="e.disabled"
          :profiles="e.profiles"
          :default-model="e.defaultModel"
          :catalog="e.catalog"
          :query="query"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.endpoints { display: flex; flex-direction: column; gap: var(--space-2); }
.endpoints__head { display: flex; align-items: center; gap: var(--space-2); }
.endpoints__title { margin: 0; font-size: var(--text-sm); font-weight: 700; flex: 1; }
.endpoints__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.endpoints__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }

.endpoints__add {
  width: 100%;
  padding: var(--space-2);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: none;
  font: inherit;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  cursor: pointer;
}
.endpoints__add:hover { color: var(--color-primary); border-color: var(--color-primary); }

.endpoint {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.endpoint--open { border-color: var(--color-primary); }

.endpoint__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.endpoint__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.endpoint__name { flex: none; font-size: var(--text-sm); font-weight: 600; }
.endpoint__url { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
.endpoint__count { flex: none; font-size: var(--text-xs); color: var(--color-text-muted); }
.endpoint__cred {
  flex: none;
  font-size: var(--text-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  padding: 0 6px;
  color: var(--color-text-muted);
}
.endpoint__cred--need { color: var(--color-warning); border-color: var(--color-warning); }
.endpoint__status { flex: none; font-size: var(--text-xs); color: var(--color-text-muted); }
.endpoint__status.is-remote { color: var(--color-success); }
.endpoint__status.is-static { color: var(--color-danger); }
.endpoint__chev { flex: none; font-size: var(--text-xs); color: var(--color-text-muted); }
.endpoint__actions { display: flex; align-items: center; gap: var(--space-1); flex: none; }

.endpoint__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-3);
}

.field { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.field__key { flex: none; width: 40px; font-size: var(--text-xs); color: var(--color-text-muted); }
.field__input { flex: 1; min-width: 140px; }
.field__hint { flex: 1; font-size: var(--text-xs); color: var(--color-text-muted); }

.wall-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}
.wall-head__title { flex: none; font-size: var(--text-xs); font-weight: 700; }
.wall-head__src { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--color-text-muted); }

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-text-muted);
}
.dot.green { background: var(--color-success); }
.dot.red { background: var(--color-danger); }
</style>
