export default {
  settings: {
    title: 'Settings',
    // S7-7: the `llm` tab became its own widget.llm-settings (owned by the models
    // plugin), so there is no settings.tabs.llm any more — keeping it would be a
    // thread pointing at a tab that doesn't exist
    tabs: { ui: 'UI', advanced: 'Advanced' },
    ui: {
      theme: 'Theme',
      themeLight: 'Light',
      themeDark: 'Dark',
      language: 'Language',
      langZh: '中文',
      langEn: 'English',
    },
    advanced: {
      retryGlobal: 'Global retry',
      logLevel: 'Log level',
      dataDir: 'Data directory',
      danger: 'Danger zone',
      resetLayout: 'Reset layout',
      resetLayoutHint: 'Restore default panel layout',
      clearSessions: 'Clear sessions',
      clearSessionsHint: 'Delete all session data',
    },
  },
}
