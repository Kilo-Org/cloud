import type { SessionProfileBundle } from './persistence/schemas.js';
import type { CloudAgentSessionState } from './persistence/types.js';
import type { SessionMetadata } from './persistence/session-metadata.js';

export type { SessionProfileBundle } from './persistence/schemas.js';

/**
 * Extract the profile-derived subset from current grouped session metadata.
 * Legacy flat profile fields are normalized by `parseSessionMetadata` before
 * general application code sees metadata.
 */
export function readProfileBundle(
  metadata: Pick<SessionMetadata, 'profile'>
): SessionProfileBundle {
  const profile = metadata.profile;
  if (!profile) return {};
  const { runtimeSkills, runtimeAgents, ...rest } = profile;
  return {
    ...rest,
    runtimeSkills: runtimeSkills ? [...runtimeSkills] : undefined,
    runtimeAgents: runtimeAgents ? [...runtimeAgents] : undefined,
  };
}

/**
 * Legacy alias retained for older call sites.
 */
export function profileFromMetadata(metadata: CloudAgentSessionState): SessionProfileBundle {
  return readProfileBundle(metadata);
}
