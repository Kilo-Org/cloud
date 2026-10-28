import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';

import { decodeBackendTarget, decodeLocalTarget } from './backend-target';

/** Where the per-chat choice lives. Absent means the default for the chat's model. */
const PREFERENCE_SCOPE = 'chat-web-search';
const ON = 'on';
const OFF = 'off';

/**
 * The choice for a chat the person never set: on for a Kilo model, off for a
 * custom backend or an on-device model. Those send the question somewhere
 * other than Kilo, so a search billed to the Kilo account is opt-in there.
 */
export function webSearchDefault(model: string): boolean {
  return decodeLocalTarget(model) === null && decodeBackendTarget(model) === null;
}

/** Whether web search is offered in one chat, on the model its next question goes to. */
export async function webSearchEnabledFor(sessionId: string, model: string): Promise<boolean> {
  const stored = await getItem(PREFERENCE_SCOPE, sessionId);
  return stored === null ? webSearchDefault(model) : stored === ON;
}

export async function setWebSearchEnabled(sessionId: string, enabled: boolean): Promise<void> {
  await setItem(PREFERENCE_SCOPE, sessionId, enabled ? ON : OFF);
}

/** Carries the person's choice across a move, which opens a new session. */
export async function moveWebSearchEnabled(from: string, to: string): Promise<void> {
  const stored = await getItem(PREFERENCE_SCOPE, from);
  await removeItem(PREFERENCE_SCOPE, from);
  if (stored === null) {
    await removeItem(PREFERENCE_SCOPE, to);
    return;
  }
  await setItem(PREFERENCE_SCOPE, to, stored);
}

/** Drops the choices of chats that are gone, which is what signing out does. */
export async function forgetWebSearchEnabled(sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    // eslint-disable-next-line no-await-in-loop -- one connection and no lock: the deletes go one at a time
    await removeItem(PREFERENCE_SCOPE, sessionId);
  }
}
