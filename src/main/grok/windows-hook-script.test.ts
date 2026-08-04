import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGrokWindowsHookScript } from './windows-hook-script'

// Why (#12326): cmd expands `%VAR:~N%` on an undefined variable to a bare `~N`
// token; the rewritten line is invalid syntax and aborts the batch with 255, so
// Grok reported every managed hook as failed whenever GROK_HOME was unset.
describe('grok managed hook script (win32)', () => {
  it('never reads a substring expansion unless the variable is defined', () => {
    const lines = buildGrokWindowsHookScript().split('\r\n')
    const substringLines = lines.filter((line) => line.includes(':~'))

    expect(substringLines).toEqual([
      'if not "%ORCA_GROK_HOME:~4096,1%"=="" set "ORCA_GROK_HOME="',
      'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."'
    ])
    // Why: expansion happens as cmd reads the line, so an `if defined` prefix on
    // the same line is too late — only a preceding jump can skip it.
    for (const line of substringLines) {
      expect(lines[lines.indexOf(line) - 1]).toBe(
        'if not defined ORCA_GROK_HOME goto :orca_grok_home_ready'
      )
    }
    expect(lines).toContain(':orca_grok_home_ready')
  })

  it('posts an empty grokHome field rather than a literal token when unset', () => {
    const script = buildGrokWindowsHookScript()
    expect(script).toContain('set "ORCA_GROK_HOME=%GROK_HOME%"')
    expect(script).toContain('--data-urlencode "grokHome=%ORCA_GROK_HOME%"')
  })
})

// Why: the failure is cmd's parser, so only a real cmd.exe run proves the fix.
describe.skipIf(process.platform !== 'win32')('grok managed hook script (win32 behavioral)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  function writeScript(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-grok-hook-'))
    dirs.push(dir)
    const scriptPath = join(dir, 'grok-hook.cmd')
    writeFileSync(scriptPath, buildGrokWindowsHookScript())
    return scriptPath
  }

  async function runHook(
    scriptPath: string,
    grokHome: string | undefined
  ): Promise<{ status: number | null; stderr: string; grokHome: string | null }> {
    const posts: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        posts.push(new URLSearchParams(body).get('grokHome') ?? '')
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ORCA_AGENT_HOOK_PORT: String(port),
        ORCA_AGENT_HOOK_TOKEN: 'test-token',
        ORCA_PANE_KEY: 'tab-1:pane-1'
      }
      delete env.ORCA_AGENT_HOOK_ENDPOINT
      delete env.GROK_HOME
      if (grokHome !== undefined) {
        env.GROK_HOME = grokHome
      }
      const result = spawnSync('cmd.exe', ['/d', '/c', scriptPath], {
        encoding: 'utf8',
        env,
        input: '{"session_id":"s"}'
      })
      return { status: result.status, stderr: result.stderr, grokHome: posts[0] ?? null }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('exits 0 and posts an empty grokHome when GROK_HOME is unset', async () => {
    const result = await runHook(writeScript(), undefined)
    expect(result.stderr).not.toContain('syntax')
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })

  it('exits 0 and posts an empty grokHome when GROK_HOME is empty', async () => {
    const result = await runHook(writeScript(), '')
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })

  it('posts a normal GROK_HOME unchanged', async () => {
    const result = await runHook(writeScript(), 'C:\\Users\\test\\.grok')
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\.grok')
  })

  // Why: the appended dot keeps a trailing backslash from escaping curl's
  // closing argv quote, which would swallow the payload option.
  it('neutralizes a trailing backslash in GROK_HOME', async () => {
    const result = await runHook(writeScript(), 'C:\\Users\\test\\.grok\\')
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\.grok\\.')
  })

  it('drops a GROK_HOME past the envelope limit', async () => {
    const result = await runHook(writeScript(), `C:\\${'a'.repeat(4096)}`)
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })
})
