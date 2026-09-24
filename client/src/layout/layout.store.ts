import { defineStore } from 'pinia'
import { usePreferences } from '@/core-sdk/usePreferences'
import { defaultWorkspace, parseWorkspace, serializeWorkspace } from './layout.model'
import type { LayoutMode, WorkspaceLayout } from './types'

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useLayoutStore = defineStore('layout', {
  state: () => ({
    mode: 'edit' as LayoutMode,
    workspace: defaultWorkspace(),
    hydrated: false,
    saving: false,
    lastError: null as string | null,
  }),
  actions: {
    async bootstrap() {
      try {
        const preferences = await usePreferences().get()
        const parsed = preferences.layout ? parseWorkspace(preferences.layout) : null
        this.workspace = parsed ?? defaultWorkspace()
        this.lastError = preferences.layout && !parsed ? '布局已损坏，已重置为默认' : null
      } catch {
        this.lastError = '加载布局失败，已使用默认布局'
        this.workspace = defaultWorkspace()
      } finally {
        this.hydrated = true
      }
    },
    updateWorkspace(next: WorkspaceLayout) {
      this.workspace = next
      this.scheduleSave()
    },
    setMode(mode: LayoutMode) {
      this.mode = mode
    },
    scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void this.saveNow(), 500)
    },
    async saveNow() {
      this.saving = true
      try {
        await usePreferences().put({ layout: serializeWorkspace(this.workspace) })
        this.lastError = null
      } catch {
        this.lastError = '保存布局失败'
      } finally {
        this.saving = false
      }
    },
    resetLayout() {
      this.workspace = defaultWorkspace()
      this.scheduleSave()
    },
  },
})
