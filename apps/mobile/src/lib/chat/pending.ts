import { z } from 'zod';

import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';

import { EFFORTS } from './effort';
import { type ChatTarget, type Question } from './state';
import { type ChatSummary } from './store';
import { derivedChatText } from './title';

/**
 * The question a chat is waiting on an answer to.
 *
 * The SDK writes a question and its answer together or neither, which is what
 * keeps a paid-for question from going back out with every later request. It
 * also means a question whose answer never arrived — the app was killed, the
 * network went, the person pressed stop — is nowhere afterwards.
 *
 * So the app remembers it with the target it was asked of and the images it
 * carries, and the chat screen draws it as the last thing said with a Retry
 * under it. It is written before any move or request and removed when the
 * answer lands, so what is here is always a question with no answer, never one
 * silently rerouted by a failed move.
 */

const SCOPE = 'chat-asked-target';
const LEGACY_SCOPE = 'chat-asked';
const askedSchema = z.object({
  text: z.string(),
  model: z.string(),
  // A question remembered before efforts existed asked with the model's default.
  effort: z.enum(EFFORTS).nullable().default(null),
  // A question remembered before images existed carries none.
  images: z.array(z.object({ media: z.string(), data: z.string() })).default([]),
  // A question remembered before failures were kept says nothing about one.
  failureKey: z.string().nullable().default(null),
});

/**
 * A question with no answer: the target and effort it was asked of, its images,
 * and the fixed copy key for why its answer failed.
 *
 * The failure is kept with the question because it outlives the process. The
 * registry holds a live failure until the next send, but a restart drops it
 * while the question stays — and the one failure whose copy carries an action
 * (the credits block and its Add credits control) would go with it.
 */
export type Asked = Question &
  ChatTarget & {
    /** Why the last answer ended with none, or null when nothing says why. */
    readonly failureKey: string | null;
  };

/** A question as it is remembered: no failure is known yet when it is asked. */
export type AskedToRemember = Omit<Asked, 'failureKey'> & {
  readonly failureKey?: string | null;
};

export async function rememberAsked(sessionId: string, asked: AskedToRemember): Promise<void> {
  await setItem(
    SCOPE,
    sessionId,
    JSON.stringify({ ...asked, failureKey: asked.failureKey ?? null })
  );
  await removeItem(LEGACY_SCOPE, sessionId);
}

/**
 * Says why the remembered question failed, so a reopened chat still tells the
 * reader instead of reading as a question the person stopped.
 *
 * A question nobody remembers has nowhere to keep it: the reason is then only
 * on screen for as long as the chat stays open, which is all there was before.
 */
export async function recordAskedFailure(sessionId: string, failureKey: string): Promise<void> {
  const asked = await askedIn(sessionId);
  if (asked === null || asked.failureKey === failureKey) {
    return;
  }
  await rememberAsked(sessionId, { ...asked, failureKey });
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
    ? rememberAsked(sessionId, { text, model, effort: null, images: [] })
    : removeItem(LEGACY_SCOPE, sessionId));
}

/** Carries the question across a model switch, which opens a new session. */
export async function moveAsked(from: string, to: string): Promise<void> {
  const asked = await askedIn(from);
  if (asked !== null) {
    await rememberAsked(to, asked);
  }
  await forgetAsked(from);
}

/**
 * Names each row that has no name yet with the question it waits on. A chat
 * whose only question failed has no stored turn to take a title from, and it
 * read as untitled although the person can see what they asked.
 *
 * The question stands in for a name, so it is reduced to one short line: the
 * header draws it in one row and reads it out as the rename control's name, and
 * a long question is not a name.
 */
export async function titledByAsked(chats: readonly ChatSummary[]): Promise<ChatSummary[]> {
  const titled = await Promise.all(
    chats.map(async chat => {
      if (chat.title !== '') {
        return chat;
      }
      const asked = await askedIn(chat.sessionId);
      return { ...chat, title: derivedChatText(asked?.text ?? '') };
    })
  );
  return titled;
}
