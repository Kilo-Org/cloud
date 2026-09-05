import { Cause, Effect, Exit, Fiber, ManagedRuntime, Option, Scope, Stream } from 'effect';
import {
  cloneSession,
  continueSession,
  type ModelEvent,
  openSession,
  type SessionHandle,
} from '@kilocode/harness-sdk';
import { type SQLiteDatabase } from 'expo-sqlite';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { change, forgetState, NOTHING, snapshotOf } from './state';
import { chatLayers, type ChatOrg } from './layers';
import { askedIn, forgetAsked, moveAsked, rememberAsked } from './pending';
import { forgetSession, modelOfSession, moveChat, rememberChat, touchChat } from './store';

/**
 * The chats that are running, for as long as they run.
 *
 * A chat is not tied to the screen showing it: a person asks something, leaves
 * for another tab, and comes back to the answer. So the live sessions live here,
 * in the module, and a screen subscribes to one rather than owning it.
 *
 * Everything a screen draws is in `ChatState`, and every change to one is
 * published to whoever is watching. Nothing here draws anything and nothing
 * here reads React.
 */

const openRuntime = (database: SQLiteDatabase, org: ChatOrg) =>
  ManagedRuntime.make(chatLayers(database, org));

type ChatRuntime = ReturnType<typeof openRuntime>;

/** Every plugin the runtime holds, which is what a session may still ask for. */
type ChatContext = ManagedRuntime.ManagedRuntime.Context<ChatRuntime>;

/**
 * A question typed while an answer was arriving, and the model it was meant
 * for. The model is carried because a person can change it between the two,
 * and the question was asked of the one that was on screen.
 */
type Waiting = {
  readonly text: string;
  readonly model: string;
};

/** A chat that is open: the session behind it, and what it is doing. */
type Chat = {
  readonly handle: SessionHandle;
  readonly scope: Scope.CloseableScope;
  answering: Fiber.RuntimeFiber<void, unknown> | undefined;
  /** What was typed while `answering` was running. Drained when it ends well. */
  readonly waiting: Waiting[];
  readonly chatScope: string;
  readonly org: ChatOrg;
};

/** Where a chat belongs, which every call needs and no chat holds before it opens. */
export type ChatPlace = {
  readonly chatScope: string;
  readonly org: ChatOrg;
};

const chats = new Map<string, Chat>();

/** One open at a time per chat, so entering a screen twice opens one session. */
const opening = new Map<string, Promise<void>>();

/**
 * One runtime per scope, because whose credit pays is part of the wiring and a
 * person switching organizations is asking for the other one. Each builds its
 * layers once and holds them for as long as the app runs, which is what keeps a
 * session alive between two visits to the screen.
 */
const runtimes = new Map<string, ChatRuntime>();

let sqlite: SQLiteDatabase | undefined = undefined;

async function open(): Promise<SQLiteDatabase> {
  sqlite ??= await encryptedDatabase();
  return sqlite;
}

async function runtimeFor(place: ChatPlace): Promise<ChatRuntime> {
  const held = runtimes.get(place.chatScope);
  if (held !== undefined) {
    return held;
  }
  const made = openRuntime(await open(), place.org);
  runtimes.set(place.chatScope, made);
  return made;
}

/**
 * Opens a session in a scope of its own, which outlives the screen that asked
 * for it. Closing that scope later is what tells the store to write down
 * whatever it still holds.
 */
async function inOwnScope<E>(
  runtime: ChatRuntime,
  opened: Effect.Effect<SessionHandle, E, ChatContext | Scope.Scope>
): Promise<{ readonly handle: SessionHandle; readonly scope: Scope.CloseableScope }> {
  const scope = await runtime.runPromise(Scope.make());
  const handle = await runtime.runPromise(Scope.extend(opened, scope));
  return { handle, scope };
}

/**
 * The system prompt, frozen for the life of every session and identical across
 * them. It is the front of the cached prefix, so it is one constant here and is
 * never built out of anything that varies.
 */
const SYSTEM =
  'You are Kilo, a helpful assistant inside a mobile app. ' +
  'Answer briefly and in plain language, in the language the person writes in. ' +
  'You have no tools, no files and no internet: when something needs one of ' +
  'those, say so rather than guessing. Use markdown sparingly, and code blocks ' +
  'for code.';

/**
 * Makes the database ready to be read.
 *
 * The SDK's store creates its own tables when its layer is built, and the list
 * joins those tables. A list drawn before any chat was ever opened would be
 * reading tables that do not exist yet, so the screen asks for the runtime
 * first and the store's own migrations run under it.
 */
export async function prepareChats(place: ChatPlace): Promise<void> {
  const runtime = await runtimeFor(place);
  await runtime.runPromise(Effect.void);
}

/** Starts a chat: a session of its own, and a row so the list has it. */
export async function startChat(place: ChatPlace, model: string): Promise<string> {
  const runtime = await runtimeFor(place);
  const { handle, scope } = await inOwnScope(runtime, openSession({ system: SYSTEM, model }));
  rememberChat(await open(), { sessionId: handle.id, scope: place.chatScope, at: Date.now() });
  chats.set(handle.id, { handle, scope, answering: undefined, waiting: [], ...place });
  change(handle.id, { ...NOTHING, model, status: 'idle' });
  return handle.id;
}

/**
 * Reopens a chat the store holds, unless it is still running from before.
 *
 * A chat that is still answering is the whole reason this registry exists, so
 * entering one twice must not restart it — and two screens entering at once
 * must not open two sessions onto one conversation.
 */
export async function enterChat(place: ChatPlace, sessionId: string): Promise<void> {
  if (chats.has(sessionId)) {
    return;
  }
  const already = opening.get(sessionId);
  if (already !== undefined) {
    await already;
    return;
  }
  const work = (async () => {
    try {
      await reopen(place, sessionId);
    } finally {
      opening.delete(sessionId);
    }
  })();
  opening.set(sessionId, work);
  await work;
}

async function reopen(place: ChatPlace, sessionId: string): Promise<void> {
  const runtime = await runtimeFor(place);
  const { handle, scope } = await inOwnScope(runtime, continueSession(sessionId));
  const turns = await runtime.runPromise(handle.history);
  const asked = await askedIn(sessionId);
  chats.set(sessionId, { handle, scope, answering: undefined, waiting: [], ...place });
  change(sessionId, {
    ...NOTHING,
    model: modelOfSession(await open(), sessionId) ?? '',
    turns,
    status: 'idle',
    asked,
  });
}

/**
 * Says something and reads the answer as it arrives.
 *
 * A model that is not the one the session was opened on moves the conversation
 * first, because a session freezes its model. The identifier changes when it
 * does, which is why this answers with the one to carry on with.
 */
export async function say(sessionId: string, text: string, model: string): Promise<string> {
  const held = chats.get(sessionId);
  if (held?.answering !== undefined) {
    /* A session answers one question at a time, and the composer stays open
       while it works. So a second question joins the line rather than racing
       the first, and it is on screen while it waits. It is held in memory
       only: an answer that is still arriving is not written down either. */
    held.waiting.push({ text, model });
    change(sessionId, { waiting: held.waiting.map(one => one.text) });
    return sessionId;
  }
  try {
    const moved = await ontoModel(sessionId, model);
    const chat = chats.get(moved);
    if (chat === undefined) {
      return moved;
    }
    const runtime = await runtimeFor(chat);
    await rememberAsked(moved, text);
    touchChat(await open(), moved, Date.now());
    change(moved, { status: 'working', answering: '', asked: text, failed: null });
    chat.answering = runtime.runFork(reading(moved, text, runtime));
    return moved;
  } catch (error) {
    /* The move, or the write that remembers the question, failed. The question
       is not lost: it stays on screen with a Retry under it, the same as one
       whose answer never arrived. */
    change(sessionId, { status: 'idle', answering: '', asked: text, failed: reason(error) });
    return sessionId;
  }
}

/** A short reason for the log, from something thrown rather than from a cause. */
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : 'the question could not be sent';

/** Asks again what was asked and never answered. */
export async function retryChat(sessionId: string): Promise<string> {
  const { asked, model } = snapshotOf(sessionId);
  if (asked === null) {
    return sessionId;
  }
  const moved = await say(sessionId, asked, model);
  return moved;
}

/** Reads one answer to the end, however it ends. */
function reading(sessionId: string, text: string, runtime: ChatRuntime): Effect.Effect<void> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return Effect.void;
  }
  let said = '';
  return Stream.runForEach(chat.handle.ask(text), (event: ModelEvent) =>
    Effect.sync(() => {
      if (event.kind === 'delta') {
        said += event.text;
        change(sessionId, { answering: said });
      }
    })
  ).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause: Cause.Cause<unknown>) =>
        Effect.promise(async () => {
          await settle(sessionId, runtime, why(cause));
        }),
      onSuccess: () =>
        Effect.promise(async () => {
          await settle(sessionId, runtime, null);
        }),
    })
  );
}

/**
 * A short reason for the log. The screen says the same thing whatever it is.
 *
 * The failure itself is read rather than the cause's own text: every error this
 * package raises is a tagged value whose fields — the status, the body, the
 * tool — are what say what happened, and none of them are in its message.
 */
function why(cause: Cause.Cause<unknown>): string {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure === undefined) {
    return Cause.pretty(cause).slice(0, 300);
  }
  try {
    return JSON.stringify(failure).slice(0, 300);
  } catch {
    // A value that will not serialise — a cycle, or a BigInt. The cause's own
    // text is all there is left to log.
    return Cause.pretty(cause).slice(0, 300);
  }
}

/**
 * What is true once an answer has ended.
 *
 * The turns come from the session rather than from what was streamed: the store
 * holds what was written, and a question that failed was never written. That
 * question stays remembered, which is what offers the Retry.
 */
async function settle(
  sessionId: string,
  runtime: ChatRuntime,
  failed: string | null
): Promise<void> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return;
  }
  const turns = await runtime.runPromise(chat.handle.history);
  if (failed === null) {
    await forgetAsked(sessionId);
  }
  chat.answering = undefined;
  change(sessionId, {
    turns,
    answering: '',
    status: 'idle',
    asked: failed === null ? null : snapshotOf(sessionId).asked,
    failed,
  });
  /* The line moves only when the answer landed. A question that failed keeps
     its Retry, and asking the next one would take the place that Retry hangs
     off — so what is waiting stays waiting until the person deals with it. */
  if (failed === null) {
    await drain(sessionId, chat);
  }
}

/**
 * Asks the next question the person left, if they left one.
 *
 * They typed it while the last answer was arriving, so it was never a draft
 * they could go back and change: it is a question they asked, and it is asked
 * as soon as the session is free.
 */
async function drain(sessionId: string, chat: Chat): Promise<void> {
  const next = chat.waiting.shift();
  if (next === undefined) {
    return;
  }
  change(sessionId, { waiting: chat.waiting.map(one => one.text) });
  await say(sessionId, next.text, next.model);
}

/**
 * Moves the chat onto the model the person picked, and answers with the session
 * to carry on with.
 *
 * The old session goes: the copy holds every turn of it, and two rows for one
 * conversation is a list that lies. What a copy cannot carry is the thinking,
 * which is signed by the model that made it — that rule is the SDK's, and this
 * only asks for the move.
 */
async function ontoModel(sessionId: string, model: string): Promise<string> {
  const chat = chats.get(sessionId);
  const held = snapshotOf(sessionId);
  if (chat === undefined || model === '' || model === held.model) {
    return sessionId;
  }
  const runtime = await runtimeFor(chat);
  const { handle, scope } = await inOwnScope(runtime, cloneSession(sessionId, { model }));
  const database = await open();
  moveChat(database, { from: sessionId, to: handle.id, at: Date.now() });
  await moveAsked(sessionId, handle.id);
  const turns = await runtime.runPromise(handle.history);
  chats.delete(sessionId);
  forgetState(sessionId);
  chats.set(handle.id, { ...chat, handle, scope, answering: undefined });
  change(handle.id, { ...held, sessionId: handle.id, model, turns });
  await runtime.runPromise(Scope.close(chat.scope, Exit.void));
  forgetSession(database, sessionId);
  return handle.id;
}

/**
 * Stops the answer that is arriving.
 *
 * Interrupting the reading aborts the request, so the provider stops sending.
 * The question stays remembered: nothing was answered, so the person is left
 * with what they asked and a Retry under it, rather than with a message that
 * vanished.
 */
export async function stopChat(sessionId: string): Promise<void> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return;
  }
  const stopped = await halt(sessionId, chat);
  if (stopped) {
    await drain(sessionId, chat);
  }
}

/**
 * Interrupts the answer arriving, and answers whether there was one.
 *
 * Interrupting the reading aborts the request, so the provider stops sending.
 * It is deliberately only the interrupt: a chat being stopped goes on to ask
 * what is waiting, and a chat being closed does not.
 */
async function halt(sessionId: string, chat: Chat): Promise<boolean> {
  if (chat.answering === undefined) {
    return false;
  }
  const runtime = await runtimeFor(chat);
  await runtime.runPromise(Fiber.interrupt(chat.answering));
  chat.answering = undefined;
  change(sessionId, { status: 'idle', answering: '' });
  return true;
}

/**
 * Ends a chat, whether it is being deleted or the account is going. Closing the
 * scope is what tells the store to write down whatever it still holds.
 */
export async function releaseChat(sessionId: string): Promise<void> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return;
  }
  await halt(sessionId, chat);
  /* Whatever was still waiting goes with the chat. Asking it now would open a
     round on a session whose scope is closing under it. */
  chat.waiting.length = 0;
  const runtime = await runtimeFor(chat);
  await runtime.runPromise(Scope.close(chat.scope, Exit.void));
  chats.delete(sessionId);
  forgetState(sessionId);
}

/** Ends every chat, which is what signing out does before the wipe. */
export async function releaseEveryChat(): Promise<void> {
  for (const sessionId of chats.keys()) {
    // eslint-disable-next-line no-await-in-loop -- one scope closes after another: the store has no lock, and two closes at once would write over each other
    await releaseChat(sessionId);
  }
}
