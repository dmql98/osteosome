import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ManifestError, loadServices, validateManifest } from '../src/service-manager/manifest'
import type { Manifest } from '@osteosome/shared'

function validManifest(id = 'hello'): Manifest {
  return {
    id,
    version: '1.0.0',
    protocolVersion: '1.0.0',
    entry: 'node service.mjs',
    inject: [],
    publishes: ['hello.command.executed'],
    subscribes: ['hello.command'],
  }
}

describe('manifest validation', () => {
  it('accepts a valid manifest', () => {
    expect(validateManifest(validManifest())).toMatchObject({ id: 'hello' })
  })

  it('fails on missing required fields', () => {
    const { id, ...noId } = validManifest()
    expect(() => validateManifest(noId)).toThrow(ManifestError)
    const { publishes, ...noPublishes } = validManifest()
    expect(() => validateManifest(noPublishes)).toThrow(ManifestError)
  })

  it('fails on incompatible protocolVersion', () => {
    expect(() => validateManifest({ ...validManifest(), protocolVersion: '9.9.9' })).toThrow(
      /incompatible/,
    )
  })

  it('fails when publishes topic is not declared in EventMap', () => {
    expect(() =>
      validateManifest({ ...validManifest(), publishes: ['ghost.event'] }),
    ).toThrow(/not declared in shared EventMap/)
  })

  it('fails when subscribes topic touches neither events nor commands', () => {
    expect(() =>
      validateManifest({ ...validManifest(), subscribes: ['ghost.command'] }),
    ).toThrow(/not declared/)
  })

  it('accepts subscribes referencing a command topic', () => {
    expect(() => validateManifest(validManifest())).not.toThrow()
  })
})

describe('loadServices', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ost-manifest-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeService(id: string, manifest: unknown): string {
    const sub = path.join(dir, id)
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'service.json'), JSON.stringify(manifest))
    return sub
  }

  it('loads and validates all services in the directory', () => {
    writeService('hello', validManifest('hello'))
    writeService('other', validManifest('other'))
    const loaded = loadServices(dir)
    expect(loaded.map((s) => s.manifest.id).sort()).toEqual(['hello', 'other'])
  })

  it('aggregates failures across services (fail fast, all reported)', () => {
    writeService('bad', { ...validManifest('bad'), protocolVersion: '2.0.0' })
    writeService('bad2', { ...validManifest('bad2'), publishes: ['nope'] })
    expect(() => loadServices(dir)).toThrow(ManifestError)
    try {
      loadServices(dir)
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError)
      expect((err as ManifestError).reasons).toHaveLength(2)
    }
  })

  it('skips directories without service.json', () => {
    mkdirSync(path.join(dir, 'junk'))
    expect(loadServices(dir)).toHaveLength(0)
  })

  it('throws when the services dir does not exist', () => {
    expect(() => loadServices(path.join(dir, 'nope'))).toThrow(/not found/)
  })
})