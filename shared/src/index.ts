export * from './events'
export * from './agent'
export * from './skills'
export * from './tools'
export * from './llm'
export * from './manifest'
export * from './paths'
export * from './plugin-manifest'
export * from './protocol'
export * from './semver'
export * from './skin'
export * from './types'
export * from './llm/stream'

/**
 * 皮肤契约的具名再导出（理由同下方 vendors 那段：`export *` 编译成 CJS 后 rollup
 * 静态分析不出具名导出，而插件 UI 会**运行时值导入** `MOTIONS` / `parseSkinCatalog`）。
 *
 * 纯打包兼容性处理，语义与上面的 `export * from './skin'` 完全一致 ——
 * 不是第二份真源。
 */
export {
  MOTIONS,
  SKIN_ASSET_EXTENSIONS,
  assertSafeAssetId,
  assertSafeAssetPath,
  assertSafeSkinId,
  availableMotions,
  isMotion,
  mergeCatalog,
  missingMotions,
  parseSkinCatalog,
  skinAssetFileName,
  skinBytes,
  sortSkins,
  unusedMotionKeys,
  type Motion,
  type SkinAsset,
  type SkinAssetKind,
  type SkinBrief,
  type SkinCatalog,
  type SkinEntry,
  type SkinSetPatch,
  type SkinSetResult,
} from './skin'

/**
 * 厂商预设**契约**的具名再导出。
 *
 * 为什么要多这一段：`export *` 编译成 CJS 后是 `__exportStar(require(...))`，rollup 静态
 * 分析不出里面的具名导出。而 client 是仓库里第一个对 `@osteosome/shared` 做**运行时值导入**
 * 的包（此前只有 type-only 导入，编译期就擦掉了），vite 打包时直接报
 * 「WIRE_OPENAI is not exported by shared/dist/index.js」。
 *
 * 具名再导出编译成每个名字一个 `defineProperty` getter，rollup 能静态看到。
 * 纯打包兼容性处理，语义与上面的 `export * from './llm'` 完全一致（不是第二份真源）。
 *
 * P5 起这里**不再导出预设数据**（`VENDOR_PRESETS` / `findVendorPreset` 已删）：
 * 数据在 `plugins/models/catalog.json`，由 `parseVendorCatalog` 校验后使用。
 */
export {
  WIRE_OPENAI,
  declaredWires,
  hasVendorCredential,
  parseVendorCatalog,
  presetsForWire,
  providerServiceIdForWire,
  resolveVendorBaseUrl,
  resolveVendorModel,
  vendorBaseUrlEnvName,
  vendorCredentialRef,
  vendorEnvSuffix,
  vendorModelEnvName,
  type VendorPreset,
} from './llm/vendors'

/**
 * 角色契约的具名再导出（理由同上：`export *` 到 rollup 看不到具名导出）。
 * 插件 UI / 服务会**运行时值导入** `mergeCharacterPatch` / `newCharacter` 等。
 */
export {
  ROLE_FRAGMENT_PREFIX,
  ROLE_FRAGMENT_PRIORITY,
  characterFragmentId,
  characterIdFromFragment,
  hasInjectablePrompt,
  mergeCharacterPatch,
  newCharacter,
  parseCharacters,
  sortCharacters,
  toRecipe,
  type AgentRecipe,
  type AgentStatePatch,
  type CharacterBrief,
} from './agent'

/**
 * 技能契约的具名再导出（理由同上）。
 */
export {
  CUSTOM_OWNER_ID,
  SKILL_INDEX_BUDGET_BYTES,
  SKILL_INDEX_MAX_ENTRIES,
  assertSafeSkillName,
  danglingBoundSkills,
  intersectRoleSkills,
  parseSkillMd,
  skillIndexBytes,
  skillIndexTotalBytes,
  skillsIndexText,
  sortSkillIndex,
  utf8Bytes,
  type SkillIndexEntry,
  type SkillPackage,
  type SkillSource,
} from './skills'