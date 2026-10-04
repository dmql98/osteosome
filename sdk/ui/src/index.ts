/**
 * `@osteosome/ui` —— 宿主与插件 UI 共用的组件库（P6 新增）
 *
 * ## 它解决什么问题
 *
 * P6 把 workbench 的六个组件搬进 `plugins/workbench/ui/` 之后，client **编译不过**了：
 * `Button` / `EmptyState` / `Switch` 这些宿主自己也在用（顶栏、插件列表窗、面板头）。
 *
 * 两条出路：各留一份 .vue，或抽成包。选后者 —— 与 P6 开头处理 `core-sdk` 是同一条理由，
 * 只是在同一个提交里差点又犯一次。
 *
 * ## 边界：纯展示
 *
 * 组件**props 进、事件出**，不自己发请求、不读 store、不 import `core-client`。
 * 这条边界是它能被插件直接用的前提：一个会自己去 `/api/command` 的组件，
 * 在别人的 iframe 里跑就会产生你意料之外的副作用。
 *
 * 需要取数的部分留给插件视图 —— 它们本来就跑在插件里，那才是正确的位置。
 *
 * ## 产物形态
 *
 * 这个包**不产出运行时 bundle**（`dist` 只是类型声明 + 构建校验用的中间产物）。
 * 消费方通过 `exports` 直接引源码 `.vue`，由各自的打包器（client 的 vite、
 * 插件 UI 的 vite）各自处理 —— 于是 vue 的运行时仍然只有一份实例，
 * 与「把 vue 打进每个插件」相比省下的正是这点。
 */
export { default as Button } from './components/Button.vue'
export { default as Card } from './components/Card.vue'
export { default as Checkbox } from './components/Checkbox.vue'
export { default as Dropdown } from './components/Dropdown.vue'
export { default as Drawer } from './components/Drawer.vue'
export { default as EmptyState } from './components/EmptyState.vue'
export { default as IconButton } from './components/IconButton.vue'
export { default as Input } from './components/Input.vue'
export { default as List } from './components/List.vue'
export { default as Modal } from './components/Modal.vue'
export { default as Select } from './components/Select.vue'
export { default as Spinner } from './components/Spinner.vue'
export { default as Switch } from './components/Switch.vue'
export { default as Tab } from './components/Tab.vue'
export { default as Table } from './components/Table.vue'
export { default as Tabs } from './components/Tabs.vue'
export { default as Textarea } from './components/Textarea.vue'
export { default as Toast } from './components/Toast.vue'
export { default as Tooltip } from './components/Tooltip.vue'