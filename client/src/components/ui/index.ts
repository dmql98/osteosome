import type { App, Plugin } from 'vue'
import Button from './Button.vue'
import Card from './Card.vue'
import Checkbox from './Checkbox.vue'
import Dropdown from './Dropdown.vue'
import Drawer from './Drawer.vue'
import EmptyState from './EmptyState.vue'
import IconButton from './IconButton.vue'
import Input from './Input.vue'
import List from './List.vue'
import Modal from './Modal.vue'
import Select from './Select.vue'
import Spinner from './Spinner.vue'
import Switch from './Switch.vue'
import Tab from './Tab.vue'
import Table from './Table.vue'
import Tabs from './Tabs.vue'
import Textarea from './Textarea.vue'
import Toast from './Toast.vue'
import Tooltip from './Tooltip.vue'
import PageHeader from '../layout/PageHeader.vue'
import Section from '../layout/Section.vue'
import SplitPane from '../layout/SplitPane.vue'

export { Button, Card, Checkbox, Dropdown, Drawer, EmptyState, IconButton, Input, List, Modal, Select, Spinner, Switch, Tab, Table, Tabs, Textarea, Toast, Tooltip, PageHeader, Section, SplitPane }

export const UiPlugin: Plugin = {
  install(app: App) {
    app.component('UiButton', Button)
    app.component('UiCard', Card)
    app.component('UiCheckbox', Checkbox)
    app.component('UiDropdown', Dropdown)
    app.component('UiDrawer', Drawer)
    app.component('UiEmptyState', EmptyState)
    app.component('UiIconButton', IconButton)
    app.component('UiInput', Input)
    app.component('UiList', List)
    app.component('UiModal', Modal)
    app.component('UiSelect', Select)
    app.component('UiSpinner', Spinner)
    app.component('UiSwitch', Switch)
    app.component('UiTab', Tab)
    app.component('UiTable', Table)
    app.component('UiTabs', Tabs)
    app.component('UiTextarea', Textarea)
    app.component('UiToast', Toast)
    app.component('UiTooltip', Tooltip)
    app.component('UiPageHeader', PageHeader)
    app.component('UiSection', Section)
    app.component('UiSplitPane', SplitPane)
  },
}
