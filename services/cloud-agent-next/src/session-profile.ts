import type { SessionProfileBundle } from './persistence/schemas.js';
import type { CloudAgentSessionState } from './persistence/types.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import { BUILTIN_AGENT_MODES } from './schema.js';

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

/**
 * A mode is valid when it is built in or matches a runtime agent installed on
 * the session. Both the legacy and the control-plane admission paths use this
 * single check.
 */
export function validateModeAgainstRuntimeAgents(
  metadata: Pick<SessionMetadata, 'agent' | 'profile'>,
  mode = metadata.agent?.mode
): string | null {
  if (!mode || BUILTIN_AGENT_MODES.has(mode)) return null;

  const knownSlugs = new Set((readProfileBundle(metadata).runtimeAgents ?? []).map(a => a.slug));
  if (knownSlugs.has(mode)) return null;

  return `Mode "${mode}" is not a built-in and does not match any runtimeAgents on this session`;
}
