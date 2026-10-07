<template>
  <div class="tv">
    <header class="tv__head">
      <span class="tv__title">工具</span>
      <span class="tv__n">{{ tools.length }}</span>
      <span class="tv__sp" />
      <nav class="tv__tabs" role="tablist">
        <button v-for="t in TABS" :key="t.key" class="tv__tab" :class="{ 'is-on': tab === t.key }" :data-testid="`tv-tab-${t.key}`" @click="tab = t.key">
          {{ t.label }}<span v-if="t.key === 'approval' && pending.length" class="tv__badge">{{ pending.length }}</span>
        </button>
      </nav>
    </header>

    <!-- 目录 -->
    <div v-if="tab === 'catalog'" class="tv__body">
      <div v-if="!tools.length" class="tv__empty"><EmptyState icon="🔧" title="目录为空" description="没有执行者注册工具（或 tools 插件未装）。" /></div>
      <table v-else class="tv__table">
        <thead><tr><th>名称</th><th>来源</th><th>风险</th><th>策略</th><th>约束</th></tr></thead>
        <tbody>
          <tr v-for="t in tools" :key="t.name" :data-testid="`tv-row-${t.name}`">
            <td class="tv__name">
              <code>{{ t.name }}</code>
              <span v-if="t.conflict" class="tv__warn" title="同名工具：后者被拒，不覆盖">⚠ 同名冲突</span>
              <span v-if="t.managedBy === 'auto'" class="tv__auto" title="由已安装技能包 / MCP 决定">自动</span>
            </td>
            <td class="tv__mono">{{ t.serviceId }}</td>
            <td><Badge :variant="riskVariant(t.risk)">{{ t.risk }}</Badge></td>
            <td>
              <Select
                v-if="t.managedBy !== 'auto'"
                :model-value="policyOf(t.name)"
                :options="policyOptions"
                :aria-label="`${t.name} 策略`"
                :data-testid="`tv-policy-${t.name}`"
                @update:model-value="(v:string|number)=>setPolicy(t.name, String(v))"
              />
              <span v-else class="tv__mono">只读（自动）</span>
            </td>
            <td class="tv__mono">{{ (t.constraintKeys ?? []).join(', ') || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 审批 -->
    <div v-else-if="tab === 'approval'" class="tv__body">
      <p v-if="!pending.length" class="tv__mono" data-testid="tv-approval-empty">（当前没有待审批）</p>
      <div v-for="p in pending" :key="p.requestId" class="tv__approval" data-testid="tv-approval">
        <div class="tv__approval-head">
          <Badge :variant="p.kind === 'workspace' ? 'warning' : 'primary'">{{ p.kind === 'workspace' ? '工作区授权' : '工具执行' }}</Badge>
          <code>{{ p.toolName }}</code>
          <span class="tv__mono">{{ p.risk }}</span>
        </div>
        <pre class="tv__args">{{ p.kind === 'workspace' ? `${p.requestedPath}\n（授权根：${p.permissionRoot}）` : p.arguments }}</pre>
        <div class="tv__approval-actions">
          <label v-if="p.risk === 'proc'" class="tv__remember"><input type="checkbox" v-model="remember[p.requestId]" /> 记住（本会话后续不再问）</label>
          <span class="tv__sp" />
          <Button size="sm" variant="ghost" @click="resolve(p.requestId, false)">拒绝</Button>
          <Button size="sm" @click="resolve(p.requestId, true)">批准</Button>
        </div>
      </div>
    </div>

    <!-- 试调 -->
    <div v-else-if="tab === 'invoke'" class="tv__body">
      <label class="tv__field"><span class="tv__label">工具</span>
        <Select :model-value="invokeTool" :options="toolOptions" data-testid="tv-invoke-tool" @update:model-value="(v:string|number)=>{ invokeTool = String(v); invokeArgs = defaultArgs(String(v)) }" />
      </label>
      <label class="tv__field"><span class="tv__label">参数（JSON）</span>
        <Textarea v-model="invokeArgs" :rows="5" data-testid="tv-invoke-args" />
      </label>
      <div class="tv__invoke-actions">
        <Button size="sm" :disabled="!invokeTool" data-testid="tv-invoke-run" @click="runInvoke">运行</Button>
      </div>
      <div v-if="invokeError" class="tv__err" data-testid="tv-invoke-error">{{ invokeError }}</div>
      <pre v-if="lastInvoke" class="tv__result" :class="{ 'is-err': !lastInvoke.ok }" data-testid="tv-invoke-result">{{ lastInvoke.ok ? '✓' : '✗' }} {{ lastInvoke.summary }}（{{ lastInvoke.elapsedMs }} ms）\n\n{{ lastInvoke.content }}</pre>
      <p class="tv__hint">试调走 <code>tools.invoke</code>；ask 策略的工具会在「审批」Tab 弹一次。</p>
    </div>

    <!-- MCP -->
    <div v-else-if="tab === 'mcp'" class="tv__body">
      <p class="tv__hint">MCP 服务器（<code>mcp-servers.json</code>）。改完保存即重连；连上的 server 的工具以 <code>&lt;server&gt;__&lt;tool&gt;</code> 出现在目录里。</p>
      <Textarea v-model="mcpDraft" :rows="8" data-testid="tv-mcp-json" />
      <div class="tv__invoke-actions">
        <Button size="sm" @click="saveMcp">保存</Button>
      </div>
      <div v-if="mcpError" class="tv__err" data-testid="tv-mcp-error">{{ mcpError }}</div>
    </div>

    <!-- 事件 -->
    <div v-else class="tv__body">
      <p v-if="!events.length" class="tv__mono">（暂无事件）</p>
      <ul v-else class="tv__events" data-testid="tv-events">
        <li v-for="(e, i) in events" :key="i" class="tv__event"><code>{{ e.topic }}</code><span class="tv__mono">{{ e.summary }}</span></li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * widget.tools —— 5 Tab：目录 / 审批 / 试调 / MCP / 事件（P7 M5）。
 *
 * 目录按来源（serviceId）分组、显示风险徽章与策略开关；`managedBy:'auto'` 的行**不给开关**
 * （由技能包 / MCP 决定，点了不生效比没有更糟）。审批 Tab 就地答 exec / workspace 两种。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Badge, Button, EmptyState, Select, Textarea } from '@osteosome/ui'
import type { ApprovalPolicy, MCPServerConfig, ToolRisk } from '@osteosome/shared'
import { useToolsState } from '../state'

const s = useToolsState()
const { tools, policies, mcpServers, pending, events, bind, dispose, setPolicy: setPolicyCmd, setMcpServers, resolveApproval, invoke, lastInvoke } = s

const TABS = [
  { key: 'catalog', label: '目录' },
  { key: 'approval', label: '审批' },
  { key: 'invoke', label: '试调' },
  { key: 'mcp', label: 'MCP' },
  { key: 'events', label: '事件' },
] as const
type TabKey = (typeof TABS)[number]['key']
const tab = ref<TabKey>('catalog')

const policyOptions: { label: string; value: ApprovalPolicy }[] = [
  { label: '自动放行', value: 'auto' },
  { label: '每次询问', value: 'ask' },
  { label: '直接拒绝', value: 'deny' },
]

const RISK_VARIANT: Record<ToolRisk, 'success' | 'danger' | 'primary' | 'warning'> = {
  read: 'success',
  write: 'danger',
  net: 'primary',
  proc: 'warning',
}
function riskVariant(r: ToolRisk) {
  return RISK_VARIANT[r] ?? 'primary'
}
function policyOf(name: string): ApprovalPolicy {
  return policies.value[name] ?? 'ask'
}
async function setPolicy(name: string, v: string): Promise<void> {
  await setPolicyCmd(name, v as ApprovalPolicy)
}

// 审批
const remember = ref<Record<string, boolean>>({})
async function resolve(id: string, approved: boolean): Promise<void> {
  await resolveApproval(id, approved, remember.value[id] === true)
}

// 试调
const invokeTool = ref('')
const invokeArgs = ref('{}')
const invokeError = ref('')
const toolOptions = computed(() => tools.value.map((t) => ({ label: t.name, value: t.name })))
function defaultArgs(name: string): string {
  const t = tools.value.find((x) => x.name === name)
  const props = (t?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  if (!props) return '{}'
  const obj: Record<string, unknown> = {}
  for (const k of Object.keys(props)) obj[k] = ''
  return JSON.stringify(obj, null, 2)
}
async function runInvoke(): Promise<void> {
  invokeError.value = ''
  let args: Record<string, unknown>
  try {
    args = JSON.parse(invokeArgs.value || '{}') as Record<string, unknown>
  } catch {
    invokeError.value = '参数不是合法 JSON'
    return
  }
  await invoke(invokeTool.value, args)
}

// MCP
const mcpDraft = ref('[]')
const mcpError = ref('')
async function saveMcp(): Promise<void> {
  mcpError.value = ''
  try {
    const parsed = JSON.parse(mcpDraft.value || '[]') as MCPServerConfig[]
    if (!Array.isArray(parsed)) throw new Error('必须是数组')
    await setMcpServers(parsed)
  } catch (err) {
    mcpError.value = String((err as Error)?.message ?? err)
  }
}

onMounted(() => {
  bind()
  mcpDraft.value = JSON.stringify(mcpServers.value, null, 2)
})
onBeforeUnmount(() => dispose())
</script>

<style scoped>
.tv { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tv__head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); border-bottom: 1px solid var(--color-border); }
.tv__title { font-weight: 600; }
.tv__n { font-size: var(--text-xs); color: var(--color-text-muted); }
.tv__sp { flex: 1; }
.tv__tabs { display: flex; gap: var(--space-1); }
.tv__tab { border: 0; background: transparent; color: var(--color-text-muted); font: inherit; font-size: var(--text-sm); padding: 4px 10px; cursor: pointer; border-bottom: 2px solid transparent; }
.tv__tab.is-on { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }
.tv__badge { margin-left: 4px; background: var(--color-primary); color: #fff; border-radius: var(--radius-full); font-size: 10px; padding: 0 5px; }
.tv__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3) var(--space-4); }
.tv__empty { padding: var(--space-5); }
.tv__table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tv__table th { text-align: left; font-size: var(--text-xs); color: var(--color-text-muted); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--color-border); }
.tv__table td { padding: 5px 8px; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.tv__name code { font-family: var(--font-mono); font-size: var(--text-xs); }
.tv__mono { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
.tv__warn { color: var(--color-warning); font-size: var(--text-xs); margin-left: var(--space-2); }
.tv__auto { color: var(--color-text-muted); font-size: var(--text-xs); margin-left: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-full); padding: 0 6px; }
.tv__approval { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3); }
.tv__approval-head { display: flex; align-items: center; gap: var(--space-2); }
.tv__args { background: var(--color-surface-2); border-radius: var(--radius-sm); padding: var(--space-2); font-size: var(--text-xs); white-space: pre-wrap; word-break: break-all; margin: var(--space-2) 0; }
.tv__approval-actions { display: flex; align-items: center; gap: var(--space-2); }
.tv__remember { font-size: var(--text-xs); color: var(--color-text-muted); }
.tv__field { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-3); }
.tv__label { font-size: var(--text-xs); color: var(--color-text-muted); }
.tv__invoke-actions { margin: var(--space-2) 0; }
.tv__result { background: var(--color-surface-2); border-radius: var(--radius-md); padding: var(--space-3); font-size: var(--text-xs); white-space: pre-wrap; word-break: break-word; }
.tv__result.is-err { border: 1px solid var(--color-danger); color: var(--color-danger); }
.tv__err { color: var(--color-danger); font-size: var(--text-xs); margin: var(--space-2) 0; }
.tv__hint { font-size: var(--text-xs); color: var(--color-text-muted); }
.tv__events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-xs); }
.tv__event { display: flex; gap: var(--space-2); font-family: var(--font-mono); }
</style>
