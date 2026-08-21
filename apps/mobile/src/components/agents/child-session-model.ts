import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { resolveMessageDisplayModel } from './message-model-label';
import { friendlyModelName } from './session-model-display';

/**
 * Resolve the display model for a child session from its transcript. The last
 * assistant message with model data wins; returns `null` when no model data
 * exists.
 */
export function getChildSessionModelLabel(
  childMessages: StoredMessage[],
  modelOptions: SessionModelOption[]
): string | null {
  for (let i = childMessages.length - 1; i >= 0; i -= 1) {
    const message = childMessages[i];
    if (message) {
      const resolved = resolveMessageDisplayModel(message);
      if (resolved) {
        return friendlyModelName(resolved.providerID, resolved.modelID, modelOptions);
      }
    }
  }
  return null;
}
