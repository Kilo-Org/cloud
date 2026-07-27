import type { SessionMetadata } from './session-metadata.js';

/**
 * Build next session metadata after a successful message admission when the
 * run's model/variant differs from the stored agent defaults.
 *
 * Returns null when nothing should be written (no agent block, or same values).
 * Call only after admission succeeded — never at resolve-before-admit time.
 */
export function nextMetadataAfterAdmittedAgentModel(
  metadata: SessionMetadata,
  admitted: { model: string; variant?: string }
): SessionMetadata | null {
  if (!metadata.agent) return null;

  const nextModel = admitted.model;
  const nextVariant = admitted.variant;
  if (metadata.agent.model === nextModel && metadata.agent.variant === nextVariant) {
    return null;
  }

  return {
    ...metadata,
    agent: {
      ...metadata.agent,
      model: nextModel,
      variant: nextVariant,
    },
    lifecycle: {
      ...metadata.lifecycle,
      version: Date.now(),
    },
  };
}
