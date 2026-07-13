const RUNTIME_SSH_AGENT_KEY_SEPARATOR = '\u0000ssh:'

/**
 * Runtime agent probes normally key by environment id. A repo reached through
 * an SSH target owned by that runtime needs a distinct cache entry, otherwise
 * the runtime host's own agents can be reused for the nested SSH host (or vice
 * versa) when the user switches projects.
 */
export function getRuntimeAgentDetectionKey(
  environmentId: string,
  connectionId?: string | null
): string {
  const targetId = connectionId?.trim()
  return targetId ? `${environmentId}${RUNTIME_SSH_AGENT_KEY_SEPARATOR}${targetId}` : environmentId
}

export function getRuntimeAgentDetectionEnvironmentId(key: string): string {
  const separatorIndex = key.indexOf(RUNTIME_SSH_AGENT_KEY_SEPARATOR)
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex)
}

export function runtimeAgentDetectionKeyMatches(
  key: string,
  environmentId: string,
  connectionId?: string | null
): boolean {
  return connectionId
    ? key === getRuntimeAgentDetectionKey(environmentId, connectionId)
    : getRuntimeAgentDetectionEnvironmentId(key) === environmentId
}
