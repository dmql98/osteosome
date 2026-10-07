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
      // This hint states a non-obvious fact: the setting cannot live in
      // preferences.json, because that file lives inside the data directory
      dataDirHint: 'Written to {file}; takes effect after a Core restart (preferences live inside the data directory, so this setting cannot go there)',
      dataDirDefault: 'Resetting will use: {path}',
      dataDirInput: 'Data directory path',
      sourceDefault: 'Default',
      sourceConfig: 'Config file',
      sourceCli: 'CLI --data',
      sourceEnv: 'Env OST_DATA',
      browse: 'Browse…',
      browseTitle: 'Choose data directory',
      save: 'Save',
      resetDefault: 'Reset',
      savedOk: 'Saved — restart Core to apply',
      resetOk: 'Reset — restart Core to apply',
      dataDirEmpty: 'Path must not be empty',
      dataDirSaveFailed: 'Save failed: {msg}',
      pickUnavailable: 'No system folder picker in this environment — type the path instead',
      danger: 'Danger zone',
      resetLayout: 'Reset layout',
      resetLayoutHint: 'Restore default panel layout',
      clearSessions: 'Clear sessions',
      clearSessionsHint: 'Delete all session data',
    },
  },
}
