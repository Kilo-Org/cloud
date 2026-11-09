import { z } from 'zod';

import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';

import { EFFORTS } from './effort';
import { type ChatTarget, type Displaced, type Question } from './state';
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
 *
 * A chat keeps one such question at a time, so a later one takes its place.
 * What it took the place of is remembered too, in the order it was asked, and
 * stays until the chat is deleted: its words may be all the person has left of
 * what they pasted.
 */

const SCOPE = 'chat-asked-target';
const LEGACY_SCOPE = 'chat-asked';
/**
 * The questions a later one took the slot from. A failed question is nowhere in
 * the session store, so what is written here is the only copy of its words.
 */
const KEPT_SCOPE = 'chat-kept-questions';
/**
 * The first question of a chat, which names it while no answer has been stored.
 * Kept apart from the other two because a question can be asked again after
 * another one took its place, and the chat is still named for what opened it.
 */
const NAME_SCOPE = 'chat-first-question';
const imagesSchema = z.array(z.object({ media: z.string(), data: z.string() })).default([]);
const askedSchema = z.object({
  text: z.string(),
  model: z.string(),
  // The kept question this one asks again, when it is a retry of one.
  from: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  /* How many turns the conversation held when this was asked. An answer to it is
     one of the turns after that count, which is how a question repeated later is
     told from the same words answered earlier. */
  after: z.number().int().nonnegative().optional(),
  // A question remembered before efforts existed asked with the model's default.
  effort: z.enum(EFFORTS).nullable().default(null),
  // A question remembered before images existed carries none.
  images: imagesSchema,
  // A question remembered before failures were kept says nothing about one.
  failureKey: z.string().nullable().default(null),
});
const keptEntrySchema = z.object({
  /* An identifier made by this version; an entry written while it was still a
     number of the list keeps its number as its name. */
  id: z.union([z.string(), z.number()]).transform(String),
  text: z.string(),
  model: z.string(),
  effort: z.enum(EFFORTS).nullable().default(null),
  images: imagesSchema,
  afterTurns: z.number().int().nonnegative(),
  // A question kept before the outcome was recorded failed its answer.
  outcome: z.enum(['failed', 'stopped']).default('failed'),
});
/** The stored list, before any entry is read: one broken entry is dropped alone. */
const keptRecordsSchema = z.array(z.unknown());

let keptCounter = 0;

/**
 * An identifier for a kept question, which names its bubble and is what its
 * Retry finds it by. It is taken from the clock and a counter rather than from
 * the list, so a question the written list does not hold yet cannot take one
 * another question already has.
 */
export function newKeptId(): string {
  keptCounter += 1;
  return `${Date.now().toString(36)}-${keptCounter.toString(36)}`;
}

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
    readonly from?: string | null;
    /** How many stored turns came before it, so its answer is searched after them. */
    readonly after?: number;
    /** Why the last answer ended without one, or null when nothing says why. */
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

/** Writes the questions a later send took the slot from, in the order they were asked. */
async function writeKept(sessionId: string, kept: readonly Displaced[]): Promise<void> {
  await setItem(KEPT_SCOPE, sessionId, JSON.stringify(kept));
}

export async function keptIn(sessionId: string): Promise<readonly Displaced[]> {
  const kept = await getItem(KEPT_SCOPE, sessionId);
  if (kept === null) {
    return [];
  }
  /* One entry this version cannot read must not take the others: the readable
     ones are answered, and the next write replaces the list with what it drew.
     A record nothing can read is the same answer, because a chat that opens
     without one bubble beats a chat that does not open. */
  try {
    const written = keptRecordsSchema.parse(JSON.parse(kept));
    return written.flatMap(entry => {
      const parsed = keptEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Writes the kept questions as the chat holds them.
 *
 * The list is handed in whole rather than changed in place: the chat's state is
 * what decides which questions are in the transcript, and writing it out means a
 * write that was refused is repaired by the next one instead of leaving a record
 * behind that the chat no longer draws.
 */
export async function replaceKept(sessionId: string, kept: readonly Displaced[]): Promise<void> {
  await writeKept(sessionId, kept);
}

/** Remembers the words a chat is named for, which are the first ones said in it. */
export async function rememberFirstQuestion(sessionId: string, text: string): Promise<void> {
  await setItem(NAME_SCOPE, sessionId, text);
}

export function firstQuestionIn(sessionId: string): Promise<string | null> {
  return getItem(NAME_SCOPE, sessionId);
}

/**
 * Forgets everything a chat's questions left outside its store: the one waiting
 * for an answer, the ones a later send kept, and the words that named it.
 * Deleting a chat and signing out both do this, so one call cannot forget half
 * of it.
 */
export async function forgetQuestions(sessionId: string): Promise<void> {
  await Promise.all([
    forgetAsked(sessionId),
    removeItem(KEPT_SCOPE, sessionId),
    removeItem(NAME_SCOPE, sessionId),
  ]);
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

/** Carries the questions across a model switch, which opens a new session. */
export async function moveQuestions(from: string, to: string): Promise<void> {
  const [asked, kept, name] = await Promise.all([
    askedIn(from),
    keptIn(from),
    firstQuestionIn(from),
  ]);
  if (asked !== null) {
    await rememberAsked(to, asked);
  }
  if (kept.length > 0) {
    await writeKept(to, kept);
  }
  if (name !== null) {
    await rememberFirstQuestion(to, name);
  }
  await forgetQuestions(from);
}

/**
 * Names each row that has no name yet with the first question it holds. A chat
 * whose only question failed has no stored turn to take a title from, and it
 * read as untitled although the person can see what they asked.
 *
 * The first question is the name, not the latest one: a failure a later send
 * kept, or asked again, still leaves the chat named for what it was opened for,
 * and the row does not rename itself while the person works through the
 * failures. A chat opened before the first question was remembered falls back to
 * the oldest question it still holds.
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
      const [name, kept, asked] = await Promise.all([
        firstQuestionIn(chat.sessionId),
        keptIn(chat.sessionId),
        askedIn(chat.sessionId),
      ]);
      return { ...chat, title: derivedChatText(name ?? kept[0]?.text ?? asked?.text ?? '') };
    })
  );
  return titled;
}
