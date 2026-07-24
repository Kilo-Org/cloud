import { getStepFinishRoutedModel } from 'cloud-agent-sdk/part-utils';

import { type StoredMessage } from 'cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { friendlyModelName } from './session-model-display';

/**
 * F3 — per-message model label helpers.
 *
 * The assistant transcript can use a different model from message to
 * message: the user switches mid-session, the CLI auto-routes a kilo-auto
 * turn to a different upstream provider, etc. We want a subtle, dimmed
 * "Claude Sonnet 4" / "Kilo Auto (efficient)" label to appear under the
 * FIRST assistant message and whenever the resolved model CHANGES relative
 * to the previous assistant message. Same-model follow-ups stay unlabelled
 * (a quiet "the model hasn't changed" signal).
 *
 * Two layers of pure functions:
 *  - {@link resolveMessageDisplayModel}: pick the concrete (providerID,
 *    modelID) for ONE assistant message, preferring the routed model on
 *    the LAST step-finish part that carries one.
 *  - {@link computeMessageModelLabels}: walk the transcript in order and
 *    produce the map of messageId -> display label for exactly the
 *    assistant messages that should render a label.
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

/**
 * Walk the ordered transcript and return the subset of assistant message
 * ids that should render a model label, mapped to their display string.
 *
 * Gating rule: the FIRST assistant message always shows its label (its
 * "previous model" is `undefined`, so the key always differs); every
 * following assistant message shows the label only when its resolved model
 * differs from the previous assistant message's resolved model. User
 * messages and other non-assistant messages are skipped and do NOT reset
 * the running key.
 */
export function computeMessageModelLabels(
  messages: readonly StoredMessage[],
  options: SessionModelOption[]
): Map<string, string> {
  const labels = new Map<string, string>();
  let previousKey: string | undefined = undefined;

  // Filter to assistant messages first so the inner loop stays straight-line
  // (no `continue`, which the lint rules forbid) while preserving order.
  const assistantMessages = messages.filter(message => message.info.role === 'assistant');

  for (const message of assistantMessages) {
    const resolved = resolveMessageDisplayModel(message);
    // Unresolvable assistant message: never labelled, and do NOT update
    // `previousKey` so the next assistant is still compared against the
    // last successfully-resolved model. This matches the F3 "Empty"
    // state (unresolvable id → no label rather than a wrong label).
    if (resolved) {
      const key = `${resolved.providerID}:${resolved.modelID}`;
      if (key !== previousKey) {
        labels.set(
          message.info.id,
          friendlyModelName(resolved.providerID, resolved.modelID, options)
        );
        previousKey = key;
      }
    }
  }

  return labels;
}
