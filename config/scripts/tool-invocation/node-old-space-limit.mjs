import os from 'node:os'

const maxOldSpaceSizeMb = 4096
const minOldSpaceSizeMb = 2048
const reservedSystemMemoryMb = 1024

const maxTypecheckOldSpaceSizeMb = 4096
const minTypecheckOldSpaceSizeMb = 2048
const reservedTypecheckSystemMemoryMb = 2048

export function getBuildOldSpaceSizeMb(totalMemoryBytes = os.totalmem()) {
  const totalMemoryMb = Math.floor(totalMemoryBytes / 1024 / 1024)
  const hostSizedLimitMb = Math.max(minOldSpaceSizeMb, totalMemoryMb - reservedSystemMemoryMb)

  return Math.min(maxOldSpaceSizeMb, hostSizedLimitMb)
}

export function appendBuildOldSpaceOption(existingNodeOptions, totalMemoryBytes = os.totalmem()) {
  const requestedNodeOptions = `--max-old-space-size=${getBuildOldSpaceSizeMb(totalMemoryBytes)}`
  const trimmedNodeOptions = existingNodeOptions?.trim()

  return trimmedNodeOptions ? `${trimmedNodeOptions} ${requestedNodeOptions}` : requestedNodeOptions
}

export function getTypecheckOldSpaceSizeMb(totalMemoryBytes = os.totalmem()) {
  const totalMemoryMb = Math.floor(totalMemoryBytes / 1024 / 1024)
  const hostSizedLimitMb = Math.max(
    minTypecheckOldSpaceSizeMb,
    totalMemoryMb - reservedTypecheckSystemMemoryMb
  )

  return Math.min(maxTypecheckOldSpaceSizeMb, hostSizedLimitMb)
}

export function appendTypecheckOldSpaceOption(
  existingNodeOptions,
  totalMemoryBytes = os.totalmem()
) {
  const requestedNodeOptions = `--max-old-space-size=${getTypecheckOldSpaceSizeMb(totalMemoryBytes)}`
  const trimmedNodeOptions = existingNodeOptions?.trim()

  return trimmedNodeOptions ? `${trimmedNodeOptions} ${requestedNodeOptions}` : requestedNodeOptions
}
