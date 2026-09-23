import { describe, expect, it } from 'vitest'
import { matchPattern } from '../src/bus/pattern'

describe('pattern', () => {
  it('matches an exact topic', () => {
    expect(matchPattern('hello.command', 'hello.command')).toBe(true)
  })

  it('wildcard * matches exactly one segment', () => {
    expect(matchPattern('hello.*', 'hello.command')).toBe(true)
    expect(matchPattern('*.command', 'hello.command')).toBe(true)
    expect(matchPattern('*.command', 'hello.command.started')).toBe(false)
  })

  it('wildcard ** matches zero or more segments', () => {
    expect(matchPattern('hello.**', 'hello.command.started')).toBe(true)
    expect(matchPattern('hello.**', 'hello.command')).toBe(true)
    expect(matchPattern('hello.**', 'hello')).toBe(true)
    expect(matchPattern('hello.**', 'world.command')).toBe(false)
  })

  it('bare * matches everything', () => {
    expect(matchPattern('*', 'hello.command.started')).toBe(true)
    expect(matchPattern('*', 'anything.at.all')).toBe(true)
  })

  it('mixed segments with ** in the middle', () => {
    expect(matchPattern('hello.**.done', 'hello.command.done')).toBe(true)
    expect(matchPattern('hello.**.done', 'hello.done')).toBe(true)
    expect(matchPattern('hello.**.done', 'hello.command.failed.done')).toBe(true)
  })

  it('does not match non-prefix false matches (service.* vs service.ready.extra)', () => {
    expect(matchPattern('service.*', 'service.ready')).toBe(true)
    expect(matchPattern('service.*', 'service.ready.extra')).toBe(false)
  })

  it('returns false for unrelated topics', () => {
    expect(matchPattern('hello.command', 'llm.request')).toBe(false)
    expect(matchPattern('service.*', 'hello.command.started')).toBe(false)
  })
})