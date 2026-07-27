import { getStepFinishRoutedModel } from 'cloud-agent-sdk/part-utils';

import { type StoredMessage } from 'cloud-agent-sdk';

/**
 * Resolve the concrete (providerID, modelID) for one assistant message.
 *
 * Prefers the routed model on the LAST step-finish part that carries one
 * (kilo-auto and mid-session switches), then falls back to info-level
 * provider/model. Used by message details (long-press sheet); the transcript
 * no longer renders a per-message model label.
 */

type ResolvedModel = { providerID: string; modelID: string };

/**
 * Pick the (providerID, modelID) that should be displayed for an assistant
 * message, preferring the routed model stamped on the last step-finish
 * part that carries one. Returns `null` for non-assistant messages or when
 * no resolvable model info is present.
 */
export function resolveMessageDisplayModel(message: StoredMessage): ResolvedModel | null {
  if (message.info.role !== 'assistant') {
    return null;
  }

  // Iterate `message.parts`, find step-finish parts, take the LAST one for
  // which `getStepFinishRoutedModel` returns a value, and use that ref.
  // (An assistant message can have several step-finish parts when the CLI
  // ran a sub-step or a tool loop; only the most recent routing wins.)
  let lastRouted: ResolvedModel | null = null;
  for (const part of message.parts) {
    if (part.type === 'step-finish') {
      const routed = getStepFinishRoutedModel(part);
      if (routed) {
        lastRouted = routed;
      }
    }
  }
  if (lastRouted) {
    return lastRouted;
  }

  // Fall back to the info-level model the message was created with.
  const { providerID, modelID } = message.info;
  if (
    typeof providerID === 'string' &&
    providerID.length > 0 &&
    typeof modelID === 'string' &&
    modelID.length > 0
  ) {
    return { providerID, modelID };
  }
  return null;
}
