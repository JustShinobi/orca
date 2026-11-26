import { describe, expect, it } from 'vitest'
import { connectableLoopbackHost, getLocalhostWorktreeRouteKey } from './localhost-worktree-labels'

describe('localhost worktree labels', () => {
  it('normalizes wildcard and bracketed IPv6 hostnames for dialers', () => {
    expect(connectableLoopbackHost('0.0.0.0')).toBe('127.0.0.1')
    expect(connectableLoopbackHost('[::]')).toBe('::1')
    expect(connectableLoopbackHost('[::1]')).toBe('::1')
    expect(connectableLoopbackHost('[2001:db8::1]')).toBe('2001:db8::1')
    expect(connectableLoopbackHost('localhost')).toBe('localhost')
  })

  it('keeps route keys unique for different ports in the same worktree', () => {
    const route = {
      projectName: 'Snap Studio',
      worktreeName: 'analytics',
      repoId: 'repo-1',
      worktreeId: 'wt-analytics'
    }

    expect(
      getLocalhostWorktreeRouteKey({
        ...route,
        targetUrl: 'http://localhost:5173/'
      })
    ).not.toBe(
      getLocalhostWorktreeRouteKey({
        ...route,
        targetUrl: 'http://localhost:7777/'
      })
    )
  })
})
