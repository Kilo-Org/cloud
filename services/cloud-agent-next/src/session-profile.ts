import type { SessionProfileBundle } from './persistence/schemas.js';
import type {
  CloudAgentSessionState,
  MCPServerConfig,
  RuntimeAgent,
  RuntimeKiloCommand,
  RuntimeSkill,
} from './persistence/types.js';

export type { SessionProfileBundle } from './persistence/schemas.js';

/**
 * Shape of persisted records that may carry profile-derived configuration in
 * either the nested `profile` form (current writers) or the legacy flat form
 * (records written before nesting landed). Both `CloudAgentSessionState` and
 * `PreparationInput` structurally match this — arrays are typed `readonly`
 * so stored metadata's `readonly` arrays assign through.
 */
type ProfileCarrier = {
  profile?: SessionProfileBundle;
  envVars?: Record<string, string>;
  encryptedSecrets?: SessionProfileBundle['encryptedSecrets'];
  setupCommands?: readonly string[];
  mcpServers?: Record<string, MCPServerConfig>;
  runtimeSkills?: readonly RuntimeSkill[];
  runtimeAgents?: readonly RuntimeAgent[];
  kiloCommands?: readonly RuntimeKiloCommand[];
};

/**
 * Extract the profile-derived subset from a persisted record, preferring the
 * nested `profile` key and falling back to the legacy flat fields on records
 * that pre-date the nesting. When the nested form is present the flat
 * fallback is ignored entirely (nested wins, even when the flat slots also
 * hold values — which should not happen since writers no longer emit them).
 *
 * Arrays are copied because zod infers mutable element types while the
 * hand-written `CloudAgentSessionState` types them `readonly`.
 */
export function readProfileBundle(record: ProfileCarrier): SessionProfileBundle {
  if (record.profile) {
    const { runtimeSkills, runtimeAgents, ...rest } = record.profile;
    return {
      ...rest,
      runtimeSkills: runtimeSkills ? [...runtimeSkills] : undefined,
      runtimeAgents: runtimeAgents ? [...runtimeAgents] : undefined,
    };
  }
  return {
    envVars: record.envVars,
    encryptedSecrets: record.encryptedSecrets,
    setupCommands: record.setupCommands ? [...record.setupCommands] : undefined,
    mcpServers: record.mcpServers,
    runtimeSkills: record.runtimeSkills ? [...record.runtimeSkills] : undefined,
    runtimeAgents: record.runtimeAgents ? [...record.runtimeAgents] : undefined,
    kiloCommands: record.kiloCommands ? [...record.kiloCommands] : undefined,
  };
}

/**
 * Legacy alias. Prefer `readProfileBundle` for new call sites — it accepts
 * any `ProfileCarrier` (metadata or preparation input), not just stored
 * metadata.
 */
export function profileFromMetadata(metadata: CloudAgentSessionState): SessionProfileBundle {
  return readProfileBundle(metadata);
}
