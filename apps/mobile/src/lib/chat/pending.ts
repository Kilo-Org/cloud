import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';

/**
 * The question a chat is waiting on an answer to.
 *
 * The SDK writes a question and its answer together or neither, which is what
 * keeps a paid-for question from going back out with every later request. It
 * also means a question whose answer never arrived — the app was killed, the
 * network went, the person pressed stop — is nowhere afterwards.
 *
 * So the app remembers it, and the chat screen draws it as the last thing said
 * with a Retry under it. It is written before the question goes out and removed
 * when the answer lands, so what is here is always a question with no answer.
 */

const SCOPE = 'chat-asked';

export async function rememberAsked(sessionId: string, text: string): Promise<void> {
  await setItem(SCOPE, sessionId, text);
}

export async function forgetAsked(sessionId: string): Promise<void> {
  await removeItem(SCOPE, sessionId);
}

export async function askedIn(sessionId: string): Promise<string | null> {
  const asked = await getItem(SCOPE, sessionId);
  return asked;
}

/** Carries the question across a model switch, which opens a new session. */
export async function moveAsked(from: string, to: string): Promise<void> {
  const text = await askedIn(from);
  await forgetAsked(from);
  if (text !== null) {
    await rememberAsked(to, text);
  }
}
