import { z } from 'zod';

import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';

/**
 * The question a chat is waiting on an answer to.
 *
 * The SDK writes a question and its answer together or neither, which is what
 * keeps a paid-for question from going back out with every later request. It
 * also means a question whose answer never arrived — the app was killed, the
 * network went, the person pressed stop — is nowhere afterwards.
 *
 * So the app remembers it with the target it was asked of, and the chat screen
 * draws it as the last thing said with a Retry under it. It is written before
 * any move or request and removed when the answer lands, so what is here is
 * always a question with no answer, never one silently rerouted by a failed move.
 */

const SCOPE = 'chat-asked-target';
const LEGACY_SCOPE = 'chat-asked';
const askedSchema = z.object({ text: z.string(), model: z.string() });

type Asked = z.infer<typeof askedSchema>;

export async function rememberAsked(sessionId: string, text: string, model: string): Promise<void> {
  await setItem(SCOPE, sessionId, JSON.stringify({ text, model }));
  await removeItem(LEGACY_SCOPE, sessionId);
}

export async function forgetAsked(sessionId: string): Promise<void> {
  await removeItem(SCOPE, sessionId);
  await removeItem(LEGACY_SCOPE, sessionId);
}

export async function askedIn(sessionId: string): Promise<Asked | null> {
  const asked = await getItem(SCOPE, sessionId);
  return asked === null ? null : askedSchema.parse(JSON.parse(asked));
}

/** Upgrades old text-only questions once, using their stored session's target. */
export async function migrateAsked(sessionId: string, model: string): Promise<void> {
  const text = await getItem(LEGACY_SCOPE, sessionId);
  if (text === null) {
    return;
  }
  await ((await askedIn(sessionId)) === null
    ? rememberAsked(sessionId, text, model)
    : removeItem(LEGACY_SCOPE, sessionId));
}

/** Carries the question across a model switch, which opens a new session. */
export async function moveAsked(from: string, to: string): Promise<void> {
  const asked = await askedIn(from);
  if (asked !== null) {
    await rememberAsked(to, asked.text, asked.model);
  }
  await forgetAsked(from);
}
