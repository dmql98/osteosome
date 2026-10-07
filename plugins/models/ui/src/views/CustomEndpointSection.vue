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
 * ## 就地添加，不另开一步
 *
 * 「＋ 新增」就在这一组里，点开是一张表单：**端点信息和凭证写在同一张弹窗**。
 * 原来凭证要另开一个 Modal，用户填完端点还得再找一次入口 —— 而「新端点要不要 key」
 * 恰恰是填端点时脑子里正在想的问题。
 *
 * ## ⚠️ 文件头不要放 JS 块注释
 *
 * Vue 的 SFC 解析器把 `<script>` **之前**的内容按 HTML 解析，
 * 注释里出现 `<dl>` 这类尖括号会被当成顶层标签，报 `Element is missing end tag`
 * 且位置完全不指向真因。所以注释一律写在 `<script>` 内部。
 */
import { Button } from '@osteosome/ui'
import { IconButton } from '@osteosome/ui'

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
}

const props = defineProps<{
  endpoints: EndpointRow[]
  probing: Record<string, boolean>
  reachable: Record<string, boolean | null>
}>()

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'edit', endpointId: string): void
  (e: 'remove', endpointId: string): void
  (e: 'probe', endpointId: string): void
}>()

function stateDot(id: string): string {
  const r = props.reachable[id]
  if (r === true) return 'green'
  if (r === false) return 'red'
  return 'gray'
}

function statusText(id: string): string {
  if (props.probing[id]) return '探测中…'
  const r = props.reachable[id]
  if (r === null) return '未测试'
  return r ? '已连通' : '连不上 · 静态清单'
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

    <div v-for="e in endpoints" :key="e.id" class="endpoint" :data-testid="`endpoint-${e.id}`">
      <span class="dot" :class="stateDot(e.id)" />
      <span class="endpoint__name">{{ e.label || e.id }}</span>
      <span class="endpoint__url mono">{{ e.baseUrl }}</span>
      <span class="endpoint__cred" :class="{ 'endpoint__cred--need': e.needsKey }">
        {{ e.needsKey ? '需要密钥' : '免凭证' }}
      </span>
      <span class="endpoint__status">{{ statusText(e.id) }}</span>
      <Button size="sm" variant="ghost" :disabled="probing[e.id]" @click="emit('probe', e.id)">
        {{ probing[e.id] ? '探测中…' : '探测' }}
      </Button>
      <Button size="sm" variant="ghost" @click="emit('edit', e.id)">编辑</Button>
      <IconButton icon="✕" label="删除" @click="emit('remove', e.id)" />
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
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.endpoint__name { font-size: var(--text-sm); font-weight: 600; flex: none; }
.endpoint__url { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
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
