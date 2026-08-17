import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { appendTypecheckOldSpaceOption } from './node-old-space-limit.mjs'

const require = createRequire(import.meta.url)
const typescriptPackageJson = require.resolve('typescript/package.json')
export const tscCli = path.join(path.dirname(typescriptPackageJson), 'bin', 'tsc')

export const TARGET_CONFIGS = {
  node: 'config/tsconfig.node.json',
  cli: 'config/tsconfig.tc.cli.json',
  web: 'config/tsconfig.tc.web.json'
}

export const TSBUILDINFO_FILES = [
  'config/tsconfig.node.tsbuildinfo',
  'config/tsconfig.tc.cli.tsbuildinfo',
  'config/tsconfig.tc.web.tsbuildinfo'
]

export function cleanTsbuildinfo(workspaceRoot = process.cwd()) {
  for (const relPath of TSBUILDINFO_FILES) {
    const fullPath = path.resolve(workspaceRoot, relPath)
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath)
      }
    } catch {
      // Best-effort cleanup of stale build info
    }
  }
}

export function resolveTargets(args = []) {
  const clean = args.includes('--clean')
  const filteredArgs = args.filter((arg) => arg !== '--clean')

  const targetArg = filteredArgs[0]
  if (targetArg && targetArg in TARGET_CONFIGS) {
    return { targets: [targetArg], clean, extraArgs: filteredArgs.slice(1) }
  }

  if (targetArg === 'all' || !targetArg) {
    return {
      targets: ['node', 'cli', 'web'],
      clean,
      extraArgs: filteredArgs.filter((a) => a !== 'all')
    }
  }

  return { targets: ['node', 'cli', 'web'], clean, extraArgs: filteredArgs }
}

export async function runTypecheck(targets, extraArgs = [], options = {}) {
  const nodeOptions = appendTypecheckOldSpaceOption(process.env.NODE_OPTIONS)

  for (const target of targets) {
    const configPath = TARGET_CONFIGS[target]
    if (!configPath) {
      throw new Error(`Unknown typecheck target: ${target}`)
    }

    const tscArgs = [tscCli, '--noEmit', '-p', configPath, ...extraArgs]

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, tscArgs, {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions
        },
        ...options
      })

      child.on('exit', (code, signal) => {
        if (signal) {
          reject(new Error(`tsc exited with signal ${signal}`))
          return
        }
        if (code !== 0) {
          reject(new Error(`tsc failed with exit code ${code}`))
          return
        }
        resolve()
      })

      child.on('error', reject)
    })
  }
}

const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '') ||
    path.basename(process.argv[1]) === 'run-typecheck.mjs')

if (isDirectExecution) {
  const { targets, clean, extraArgs } = resolveTargets(process.argv.slice(2))

  if (clean) {
    cleanTsbuildinfo()
  }

  try {
    await runTypecheck(targets, extraArgs)
  } catch {
    process.exit(1)
  }
}
