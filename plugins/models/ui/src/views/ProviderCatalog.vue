<script setup lang="ts">
/**
 * 未连接的预设 —— 12 家里还没成为实例的那些。
 *
 * ## 为什么不做成可展开的行
 *
 * 展开要展示「端点 / 模型」并允许就地改，但**没配凭证的云厂商改了也没用**：
 * `instanceFromOverride` 在 `credentialRef` 解析不出来时返回 `null`，
 * 那条 override 根本不会成为实例。于是「填了端点」看起来成功、实际毫无效果 ——
 * 这是旧版最容易骗人的地方。
 *
 * 所以这里一行一家，只回答两件事：**这家需要什么**，以及**下一步点哪**。
 * 免凭证的本地端点 → 「连接」直接探；要密钥的 → 先「设置密钥」，
 * 密钥一落库上游自动探测，通了它自己就挪到上面的已连接卡片区。
 *
 * ## 点了必须有反应
 *
 * 按钮在探测期间转成「探测中…」并 disable，右侧同时亮出 `未测试 / 探测中 / 可达 / 不可达`。
 * 光发一个命令、页面纹丝不动，用户只会判定「点了连接没反应」——
 * 而探测结果本来就在 `results` 里躺着，只是这里从没接过线。
 *
 * ## 默认收起
 *
 * 12 家里通常只连 1–2 家，剩下的 11 行是噪音。收起后页面只剩真正在用的卡片。
 * 但**一搜索就展开**：搜索却什么都搜不到，比展开更让人怀疑页面坏了。
 */
import { Button } from '@osteosome/ui'

export interface PendingRow {
  id: string
  label: string
  /** 空串 = 免凭证（本地端点） */
  credentialEnv: string
  /** 本插件的凭证文件里已有这家的密钥 */
  hasKey: boolean
}

type ProbeStatus = 'idle' | 'probing' | 'ok' | 'fail'

const props = withDefaults(
  defineProps<{
    /** 已按搜索词过滤过的行 */
    rows: PendingRow[]
    /** 未连接的预设总数（不分搜索词 —— 计数要能说明「还剩几家没接」） */
    total: number
    open: boolean
    /** provider → 是否正在探测 */
    probing?: Record<string, boolean>
    /** provider → 是否可达；`undefined` = 还没探过（与「探过了不行」分开显示） */
    reachable?: Record<string, boolean | null>
  }>(),
  { probing: () => ({}), reachable: () => ({}) },
)

const emit = defineEmits<{
  (e: 'toggle-open'): void
  (e: 'set-key', providerId: string): void
  (e: 'connect', providerId: string): void
}>()

/** 要密钥但还没给 → 「连接」点了只会空转 8 秒超时，不如把它按住 */
function canConnect(row: PendingRow): boolean {
  return Boolean(row.credentialEnv) === false || row.hasKey
}

function needText(row: PendingRow): string {
  if (!row.credentialEnv) return '免凭证 · 直连'
  return row.hasKey ? `已给密钥 · ${row.credentialEnv}` : `需要 ${row.credentialEnv}`
}

function statusOf(id: string): ProbeStatus {
  if (props.probing[id] === true) return 'probing'
  const reachable = props.reachable[id]
  if (reachable === true) return 'ok'
  if (reachable === false) return 'fail'
  return 'idle'
}

const STATUS_TEXT: Record<ProbeStatus, string> = {
  idle: '未测试',
  probing: '探测中…',
  ok: '✓ 可达',
  fail: '✗ 不可达',
}

function statusText(id: string): string {
  return STATUS_TEXT[statusOf(id)]
}

function connectTitle(row: PendingRow): string {
  if (statusOf(row.id) === 'probing') return '正在探测，稍候'
  return canConnect(row) ? '连一次，通了就挪到已连接' : '先设置密钥才能连'
}
</script>

<template>
  <section class="catalog">
    <button
      type="button"
      class="catalog__head"
      data-testid="vendor-dir"
      :aria-expanded="open ? 'true' : 'false'"
      @click="emit('toggle-open')"
    >
      <span class="catalog__chev" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="catalog__title">未连接的预设 ({{ total }})</span>
      <span class="catalog__chev" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-show="open" class="catalog__body">
      <p v-if="!rows.length" class="catalog__empty">没有匹配的服务商。</p>
      <div
        v-for="v in rows"
        :key="v.id"
        class="row"
        :data-testid="`vendor-${v.id}`"
      >
        <span class="row__logo" aria-hidden="true">{{ v.label.slice(0, 1) }}</span>
        <span class="row__name">{{ v.label }}</span>
        <span class="row__id mono">{{ v.id }}</span>
        <span class="row__need">{{ needText(v) }}</span>
        <span
          class="row__status"
          :class="`row__status--${statusOf(v.id)}`"
          :data-testid="`vendor-probe-${v.id}`"
        >
          {{ statusText(v.id) }}
        </span>
        <span class="row__actions">
          <Button
            v-if="v.credentialEnv"
            size="sm"
            variant="ghost"
            :data-testid="`vendor-setkey-${v.id}`"
            @click="emit('set-key', v.id)"
          >
            {{ v.hasKey ? '换密钥' : '设置密钥' }}
          </Button>
          <Button
            size="sm"
            :disabled="!canConnect(v) || statusOf(v.id) === 'probing'"
            :title="connectTitle(v)"
            :data-testid="`vendor-connect-${v.id}`"
            @click="emit('connect', v.id)"
          >
            {{ statusOf(v.id) === 'probing' ? '探测中…' : '连接' }}
          </Button>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.catalog { display: flex; flex-direction: column; gap: var(--space-1); }
.catalog__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--color-text-muted);
  cursor: pointer;
  text-align: left;
}
.catalog__chev { flex: none; font-size: var(--text-xs); }
.catalog__title { flex: 1; font-size: var(--text-xs); font-weight: 700; }

.catalog__body { display: flex; flex-direction: column; gap: var(--space-1); }
.catalog__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.row__logo {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-3);
  font-size: var(--text-xs);
  font-weight: 700;
}
.row__name { flex: none; font-size: var(--text-sm); font-weight: 600; }
.row__id { flex: none; font-size: var(--text-xs); color: var(--color-text-muted); }
.row__need { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--color-text-muted); overflow-wrap: anywhere; }
.row__status {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.row__status--probing { color: var(--color-accent, currentColor); }
.row__status--ok { color: var(--color-success, currentColor); }
.row__status--fail { color: var(--color-danger, currentColor); }
.row__actions { display: flex; gap: var(--space-1); flex: none; }
</style>
