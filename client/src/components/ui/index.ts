/**
 * 宿主自己的 UI 装配 —— **组件全部来自 `@osteosome/ui`**（P6）。
 *
 * ## 这个文件现在只剩「注册」这一件事
 *
 * 组件的**源码**在 `sdk/ui/src/components/`，宿主与各插件 UI 共用一份。
 * 之前这里是 19 个本地 .vue + 一张注册表；搬走组件之后，剩下的唯一职责是
 * 「把宿主要用到的那几个**全局注册**」（`UiButton` 这种写法在本仓库里到处用）。
 *
 * ## 为什么仍然要注册，而不是改成逐处 import
 *
 * 模板里 `<UiButton>` 出现上百处。逐处改成 `import { Button }` + `<Button>` 是一次
 * 纯机械但波及面极大的改名，而收益只是「少一个全局注册表」。
 * 插件 UI 那侧则相反：它用的是具名 import（`import { Button } from '@osteosome/ui'`），
 * 因为插件视图是我们新写的，顺手就用了正确形态。
 *
 * **两处形态不同是有意的**：宿主不追求改动面最小，插件新代码不该带上前包袱。
 */
import type { App, Plugin } from 'vue'
import {
  Button,
  Checkbox,
  Dropdown,
  Drawer,
  EmptyState,
  IconButton,
  List,
  Modal,
  Select,
  Switch,
  Tab,
  Tooltip,
} from '@osteosome/ui'
import PageHeader from '../layout/PageHeader.vue'
import Section from '../layout/Section.vue'
import SplitPane from '../layout/SplitPane.vue'

export {
  Button, Checkbox, Dropdown, Drawer, EmptyState, IconButton, List,
  Modal, Select, Switch, Tab, Tooltip,
  PageHeader, Section, SplitPane,
}

export const UiPlugin: Plugin = {
  install(app: App) {
    app.component('UiButton', Button)
    app.component('UiCheckbox', Checkbox)
    app.component('UiDropdown', Dropdown)
    app.component('UiDrawer', Drawer)
    app.component('UiEmptyState', EmptyState)
    app.component('UiIconButton', IconButton)
    app.component('UiList', List)
    app.component('UiModal', Modal)
    app.component('UiSelect', Select)
    app.component('UiSwitch', Switch)
    app.component('UiTab', Tab)
    app.component('UiTooltip', Tooltip)
    app.component('UiPageHeader', PageHeader)
    app.component('UiSection', Section)
    app.component('UiSplitPane', SplitPane)
  },
}