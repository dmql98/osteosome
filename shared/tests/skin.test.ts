/**
 * 皮肤清单单测 —— `parseSkinCatalog` / `mergeCatalog` / 路径与 id 校验。
 *
 * 覆盖的设计承诺（逐条对应 shared/src/skin.ts 里的断言）：
 * - 逐条报，不整份拒：一条坏皮肤不影响其余
 * - 路径穿越 / 危险 assetId / 危险 skinId 在**写入时**就拒（第一道闸）
 * - `motions` 为空合法；六个之外的动作名合法但不被引用（**但值仍要校验**）
 * - 重复 id 报错并保留先到的那条
 * - 缺 license 只标警示不拒（由界面负责显示警示）
 * - mergeCatalog：内置以 fresh 为准、用户皮以 persisted 为准、孤儿内置皮留痕
 */
import { describe, expect, it } from 'vitest'
import {
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
  type SkinAsset,
  type SkinEntry,
} from '../src/skin'

/** 一条合法的资产记录 */
function asset(over: Partial<SkinAsset> = {}): SkinAsset {
  return { assetId: 'a1b2c3d4', bytes: 1024, mtime: 1735689600000, ext: 'webp', ...over }
}

/** 一条合法的皮肤（测试里不必每次写全 —— 省掉的就是被测的那条规范化） */
function entry(over: Partial<SkinEntry> & { id: string }): SkinEntry {
  return { name: over.id, builtin: true, ...over }
}

/** 一份合法的最小清单 */
function ok(skins: SkinEntry[] = [entry({ id: 'default' })]): { version: 1; skins: SkinEntry[] } {
  return { version: 1, skins }
}

/** 六个动作齐全的一套 */
function fullMotions(): Record<string, SkinAsset> {
  const out: Record<string, SkinAsset> = {}
  for (const m of MOTIONS) out[m] = asset()
  return out
}

describe('parseSkinCatalog · 合法输入', () => {
  it('最小清单 → builtin 缺省 true、enabled 缺省 true、assets/motions 补成空对象', () => {
    const r = parseSkinCatalog(ok())
    expect(r.errors).toEqual([])
    expect(r.skins).toHaveLength(1)
    expect(r.skins[0]).toEqual({
      id: 'default',
      name: 'default',
      builtin: true,
      enabled: true,
      assets: {},
      motions: {},
    })
  })

  it('enabled:false 保留（停用是可逆的，与删除分开两件事）', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'ink', name: '水墨', enabled: false })]))
    expect(r.errors).toEqual([])
    expect(r.skins[0].enabled).toBe(false)
  })

  it('enabled 非布尔 → 整条皮肤标无效（与 builtin 同一处置）', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'bad', name: 'x', enabled: 'no' as unknown as boolean })]))
    expect(r.skins).toHaveLength(0)
    expect(r.errors.join()).toContain('enabled must be a boolean')
  })

  it('完整六动作 + 静态资产全部保留', () => {
    const r = parseSkinCatalog(
      ok([
        entry({
          id: 'miku',
          name: '初音',
          assets: { portrait: asset({ assetId: 'p0000001' }), avatar: asset({ assetId: 'a0000002', ext: 'png' }) },
          motions: fullMotions(),
          license: 'MIT',
          providedBy: 'skins',
          createdAt: 1,
          updatedAt: 2,
        }),
      ]),
    )
    expect(r.errors).toEqual([])
    const s = r.skins[0]
    expect(Object.keys(s.motions)).toHaveLength(6)
    expect(availableMotions(s)).toEqual([...MOTIONS])
    expect(missingMotions(s)).toEqual([])
    expect(s.license).toBe('MIT')
    expect(s.createdAt).toBe(1)
  })

  it('motions 为空 → 合法（静态皮肤也是皮肤）', () => {
    const r = parseSkinCatalog(ok())
    expect(availableMotions(r.skins[0])).toEqual([])
    expect(missingMotions(r.skins[0])).toEqual([...MOTIONS])
  })

  it('assets 只给一个键 → 另一个保持缺省（不是空串也不是 null）', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'a', assets: { avatar: asset() } })]))
    expect(r.skins[0].assets).toEqual({ avatar: asset() })
    expect(r.skins[0].assets.portrait).toBeUndefined()
  })

  it('显式 builtin:false → 保留（用户自建皮）', () => {
    expect(parseSkinCatalog(ok([entry({ id: 'p', builtin: false })])).skins[0].builtin).toBe(false)
  })

  it('缺 license → 通过（界面负责显示警示，不是这里拒）', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'p' })]))
    expect(r.errors).toEqual([])
    expect(r.skins[0].license).toBeUndefined()
  })
})

describe('parseSkinCatalog · 逐条报，不整份拒', () => {
  it('一条坏皮肤不影响其余（核心承诺）', () => {
    const r = parseSkinCatalog(
      ok([entry({ id: 'good1' }), entry({ id: 'bad', name: 123 as unknown as string }), entry({ id: 'good2' })]),
    )
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('skins[1]')
    expect(r.skins.map((s) => s.id)).toEqual(['good1', 'good2'])
  })

  it('两条都坏 → 两条错误，返回空清单而不是抛', () => {
    const r = parseSkinCatalog(
      ok([entry({ id: 'x', builtin: 'yes' as unknown as boolean }), entry({ id: 'y', name: 1 as unknown as string })]),
    )
    expect(r.skins).toEqual([])
    expect(r.errors).toHaveLength(2)
  })

  it('id / name 缺字段 → 拒', () => {
    expect(parseSkinCatalog({ version: 1, skins: [{ name: '只有名字' }] }).errors[0]).toContain(
      'id must be a string',
    )
  })
})

describe('assertSafeAssetPath · 第一道闸', () => {
  const rejected = [
    '/etc/passwd',
    '\\windows\\system32',
    'C:/Windows/x.png',
    'C:\\Windows\\x.png',
    '../secrets.json',
    'assets/../../../../etc/passwd',
    '..\\..\\x.png',
    '..',
    '',
    '   ',
    'a\u0000b.png',
  ]
  rejected.forEach((p) => {
    it(`拒 ${JSON.stringify(p)}`, () => {
      expect(assertSafeAssetPath(p)).toBe(false)
    })
  })

  const accepted = ['a.webp', './a.webp', 'assets/a.webp', 'a/b/c.webp', '中文名.png', '.hidden.webp']
  accepted.forEach((p) => {
    it(`放行 ${JSON.stringify(p)}`, () => {
      expect(assertSafeAssetPath(p)).toBe(true)
    })
  })
})

describe('assertSafeAssetId · 第二道闸（会被拼成落盘路径）', () => {
  it('合法：8-64 位的字母数字与 - _', () => {
    expect(assertSafeAssetId('a1b2c3d4')).toBe(true)
    expect(assertSafeAssetId('abc-DEF_12345678')).toBe(true)
  })

  const rejected = [
    ['太短', 'abc'],
    ['带斜杠', 'abc/../../x'],
    ['带反斜杠', 'abc\\x'],
    ['带点', 'abc.png'],
    ['带空格', 'abc def'],
    ['64 位以上', 'a'.repeat(65)],
    ['非字符串', 42],
  ] as const
  rejected.forEach(([label, v]) => {
    it(`拒：${label}`, () => {
      expect(assertSafeAssetId(v)).toBe(false)
    })
  })

  it('清单里的坏 assetId → 整条皮肤无效', () => {
    const r = parseSkinCatalog(
      ok([entry({ id: 'good' }), entry({ id: 'bad', assets: { avatar: asset({ assetId: '../x' }) } })]),
    )
    expect(r.errors[0]).toContain('assetId must be')
    expect(r.skins.map((s) => s.id)).toEqual(['good'])
  })
})

describe('assertSafeSkinId', () => {
  it('用户起的名字放宽到 Unicode，但不许碰路径', () => {
    expect(assertSafeSkinId('我的皮肤')).toBe(true)
    expect(assertSafeSkinId('my-skin_01')).toBe(true)
    expect(assertSafeSkinId('')).toBe(false)
    expect(assertSafeSkinId('a/b')).toBe(false)
    expect(assertSafeSkinId('..')).toBe(false)
    expect(assertSafeSkinId('a'.repeat(65))).toBe(false)
  })

  it('清单里的坏 skin id → 拒', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'a/b' })]))
    expect(r.skins).toEqual([])
    expect(r.errors[0]).toContain('must not contain path separators')
  })
})

describe('parseSkinCatalog · 六个之外的动作名（输入宽、输出窄）', () => {
  it('blink 不报错，但不被引用', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'x', motions: { idle: asset(), blink: asset() } })]))
    expect(r.errors).toEqual([])
    expect(Object.keys(r.skins[0].motions)).toEqual(['idle'])
  })

  it('unusedMotionKeys 有序返回', () => {
    expect(unusedMotionKeys({ walk: asset(), blink: asset(), idle: asset() })).toEqual(['blink', 'walk'])
  })

  it('六个之外的记录若坏 → 仍然拒（值会被拼成落盘路径）', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'x', motions: { blink: asset({ assetId: 'short' }) } })]))
    expect(r.skins).toEqual([])
    expect(r.errors[0]).toContain('motions.blink')
  })
})

describe('parseSkinCatalog · 资产字段校验', () => {
  it('ext 不在白名单 → 拒（mp4 会被 MIME 表回落成 octet-stream）', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'x', assets: { avatar: asset({ ext: 'mp4' as never }) } })]))
    expect(r.skins).toEqual([])
    expect(r.errors[0]).toContain('ext must be one of')
    expect(SKIN_ASSET_EXTENSIONS).not.toContain('mp4')
  })

  it('bytes / mtime 非有限数 → 拒', () => {
    expect(
      parseSkinCatalog(ok([entry({ id: 'x', assets: { avatar: asset({ bytes: NaN }) } })])).errors[0],
    ).toContain('bytes must be')
    expect(
      parseSkinCatalog(ok([entry({ id: 'x', assets: { avatar: asset({ mtime: -1 }) } })])).errors[0],
    ).toContain('mtime must be')
  })

  it('资产不是对象 / assets 不是对象 / motions 不是对象 → 拒', () => {
    expect(parseSkinCatalog(ok([entry({ id: 'x', assets: [] as never })])).errors[0]).toContain(
      'assets must be an object',
    )
    expect(parseSkinCatalog(ok([entry({ id: 'x', motions: 'nope' as never })])).errors[0]).toContain(
      'motions must be an object',
    )
    expect(
      parseSkinCatalog(ok([entry({ id: 'x', assets: { avatar: 'nope' as never } })])).errors[0],
    ).toContain('assets.avatar is not an object')
  })
})

describe('parseSkinCatalog · 重复 id', () => {
  it('报错并保留先到的那条（不静默覆盖）', () => {
    const r = parseSkinCatalog(
      ok([entry({ id: 'dup', name: '第一个' }), entry({ id: 'dup', name: '第二个', builtin: false })]),
    )
    expect(r.skins).toHaveLength(1)
    expect(r.skins[0].name).toBe('第一个')
    expect(r.errors[0]).toContain('duplicate skin id')
  })
})

describe('parseSkinCatalog · 顶层形状', () => {
  it('非对象 / 数组 → 拒', () => {
    expect(parseSkinCatalog(null).errors[0]).toContain('not an object')
    expect(parseSkinCatalog([]).errors[0]).toContain('not an object')
  })

  it('version 不是 1 → 整份拒（跨版本字段语义可能变了）', () => {
    const r = parseSkinCatalog({ version: 2, skins: [] })
    expect(r.skins).toEqual([])
    expect(r.errors[0]).toContain('catalog.version must be 1')
  })

  it('skins 不是数组 / 元素不是对象 → 拒', () => {
    expect(parseSkinCatalog({ version: 1, skins: 'nope' }).errors[0]).toContain('catalog.skins is not an array')
    expect(parseSkinCatalog({ version: 1, skins: ['x', 42] }).errors).toHaveLength(2)
  })
})

describe('isMotion', () => {
  it('六个 → true；其余 → false', () => {
    MOTIONS.forEach((m) => expect(isMotion(m)).toBe(true))
    expect(isMotion('blink')).toBe(false)
    expect(isMotion(42)).toBe(false)
    expect(isMotion(undefined)).toBe(false)
  })
})

describe('sortSkins', () => {
  it('内置在前，再按 name（不按 updatedAt —— 否则点着的那行会跳走）', () => {
    const r = parseSkinCatalog(
      ok([
        entry({ id: 'zc', name: 'Zed', builtin: false, updatedAt: 9 }),
        entry({ id: 'bi', name: 'beta', updatedAt: 1 }),
        entry({ id: 'ac', name: 'Alpha', builtin: false, updatedAt: 8 }),
        entry({ id: 'ai', name: 'Alpha', updatedAt: 7 }),
      ]),
    )
    expect(sortSkins(r.skins).map((s) => s.id)).toEqual(['ai', 'bi', 'ac', 'zc'])
  })

  it('不改动入参', () => {
    const r = parseSkinCatalog(ok([entry({ id: 'b', builtin: false }), entry({ id: 'a' })]))
    const before = r.skins.map((s) => s.id)
    sortSkins(r.skins)
    expect(r.skins.map((s) => s.id)).toEqual(before)
  })
})

describe('availableMotions / missingMotions', () => {
  it('部分动作 → 两边互补且并起来正好是六个', () => {
    const r = parseSkinCatalog(
      ok([entry({ id: 'x', builtin: false, motions: { idle: asset(), working: asset() } })]),
    )
    const s = r.skins[0]
    expect(availableMotions(s)).toEqual(['idle', 'working'])
    expect(missingMotions(s)).toEqual(['thinking', 'speaking', 'success', 'error'])
    expect([...availableMotions(s), ...missingMotions(s)].sort()).toEqual([...MOTIONS].sort())
  })
})

describe('skinBytes / skinAssetFileName', () => {
  it('占用字节 = 静态资产 + 动作资产', () => {
    const r = parseSkinCatalog(
      ok([
        entry({
          id: 'x',
          assets: { portrait: asset({ bytes: 100 }), avatar: asset({ bytes: 20 }) },
          motions: { idle: asset({ bytes: 5 }) },
        }),
      ]),
    )
    expect(skinBytes(r.skins[0])).toBe(125)
  })

  it('空皮肤 = 0', () => {
    expect(skinBytes(parseSkinCatalog(ok()).skins[0])).toBe(0)
  })

  it('文件名由 assetId + ext 拼出（路径规则只有这一处）', () => {
    expect(skinAssetFileName(asset({ assetId: 'deadbeef', ext: 'png' }))).toBe('assets/deadbeef.png')
  })
})

describe('mergeCatalog · 内置以代码为准、用户皮以数据为准', () => {
  it('插件新带的内置皮会出现（用户文件里没有它时也该出现）', () => {
    const r = mergeCatalog(
      { skins: [entry({ id: 'default', name: 'Default' })] },
      { skins: [entry({ id: 'default', name: 'Default' }), entry({ id: 'neon', name: 'Neon' })] },
    )
    expect(r.skins.map((s) => s.id)).toEqual(['default', 'neon'])
    expect(r.changed).toBe(true)
  })

  it('落盘顺序按 name 的码位比（中文名下的结果不随直觉走，但必须是确定的）', () => {
    // 「霓」U+9713 < 「默」U+9ED8，所以霓虹排在默认**前**面。
    // 断言写死这个结果，是为了让「顺序偶然对」变成「顺序被钉住」——
    // 否则哪天有人加了 localeCompare，落盘顺序会静默变化而 `changed` 永远为 true。
    const r = mergeCatalog(
      { skins: [] },
      { skins: [entry({ id: 'a', name: '默认' }), entry({ id: 'b', name: '霓虹' })] },
    )
    expect(r.skins.map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('只是顺序不同不算变更（否则每次启动都会重播整份）', () => {
    const a = entry({ id: 'a', name: 'Default' })
    const b = entry({ id: 'b', name: 'Neon' })
    // persisted 是未排序的（用户手改过），merge 后应被排好序但仍报「无变更」
    const r = mergeCatalog({ skins: [b, a] }, { skins: [a, b] })
    expect(r.changed).toBe(false)
  })

  it('用户改过内置皮的名字 → 被覆盖（内置皮是产品的，用户对它没有所有权）', () => {
    const r = mergeCatalog(
      { skins: [entry({ id: 'default', name: '我改的名字' })] },
      { skins: [entry({ id: 'default', name: '默认' })] },
    )
    expect(r.skins[0].name).toBe('默认')
  })

  it('内置皮从版本里消失 → 不静默丢，进 orphanedBuiltin', () => {
    const r = mergeCatalog(
      { skins: [entry({ id: 'default' }), entry({ id: 'gone', name: '已下线' })] },
      { skins: [entry({ id: 'default' })] },
    )
    expect(r.skins.map((s) => s.id).sort()).toEqual(['default', 'gone'])
    expect(r.orphanedBuiltin).toEqual(['gone'])
  })

  it('用户皮永远保留，fresh 覆盖不进去', () => {
    const mine = entry({ id: 'mine', name: '我的', builtin: false })
    const r = mergeCatalog(
      { skins: [mine] },
      { skins: [entry({ id: 'mine', name: '覆盖我' })] },
    )
    expect(r.skins[0].name).toBe('我的')
    expect(r.skins[0].builtin).toBe(false)
  })

  it('用户皮不会进 orphanedBuiltin（它不是内置的）', () => {
    const r = mergeCatalog({ skins: [entry({ id: 'mine', builtin: false })] }, { skins: [] })
    expect(r.orphanedBuiltin).toEqual([])
    expect(r.skins.map((s) => s.id)).toEqual(['mine'])
  })

  it('内容没变 → changed:false（服务据此只重播差异）', () => {
    const same = [entry({ id: 'default', name: '默认' })]
    const r = mergeCatalog({ skins: [...same] }, { skins: [...same] })
    expect(r.changed).toBe(false)
  })

  it('两边都空 → 不炸', () => {
    const r = mergeCatalog({ skins: [] }, { skins: [] })
    expect(r.skins).toEqual([])
    expect(r.changed).toBe(false)
  })
})
