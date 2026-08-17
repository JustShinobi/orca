import { describe, expect, it } from 'vitest'
import { resolveTargets, TARGET_CONFIGS, TSBUILDINFO_FILES } from './run-typecheck.mjs'

describe('run-typecheck resolution', () => {
  it('defaults to all targets (node, cli, web) when no target is passed', () => {
    const { targets, clean, extraArgs } = resolveTargets([])
    expect(targets).toEqual(['node', 'cli', 'web'])
    expect(clean).toBe(false)
    expect(extraArgs).toEqual([])
  })

  it('selects a single target when specified', () => {
    const { targets, clean } = resolveTargets(['web'])
    expect(targets).toEqual(['web'])
    expect(clean).toBe(false)
  })

  it('detects --clean flag and strips it from extra arguments', () => {
    const { targets, clean, extraArgs } = resolveTargets(['node', '--clean'])
    expect(targets).toEqual(['node'])
    expect(clean).toBe(true)
    expect(extraArgs).toEqual([])
  })

  it('has valid target config mappings for node, cli, and web', () => {
    expect(TARGET_CONFIGS.node).toBe('config/tsconfig.node.json')
    expect(TARGET_CONFIGS.cli).toBe('config/tsconfig.tc.cli.json')
    expect(TARGET_CONFIGS.web).toBe('config/tsconfig.tc.web.json')
  })

  it('tracks tsbuildinfo files for all three targets', () => {
    expect(TSBUILDINFO_FILES).toHaveLength(3)
    expect(TSBUILDINFO_FILES).toContain('config/tsconfig.node.tsbuildinfo')
    expect(TSBUILDINFO_FILES).toContain('config/tsconfig.tc.cli.tsbuildinfo')
    expect(TSBUILDINFO_FILES).toContain('config/tsconfig.tc.web.tsbuildinfo')
  })
})
