export {
  loadConfig,
  DEFAULT_PORT,
  type CoreConfig,
  type DataDirSource,
} from './config'
export { readBootConfig, writeBootConfig, type BootConfig } from './boot-config'
export {
  ensureDir,
  preferencesFile,
  userDataDir,
  installRoot,
  appRoot,
  bootConfigFile,
  BOOT_CONFIG_NAME,
  coreVersion,
  migrateLegacyDataDir,
  migrateFlatLayout,
  migratePluginOwnedData,
  LEGACY_DATA_DIR,
  DIST_MARKER,
} from './paths'
