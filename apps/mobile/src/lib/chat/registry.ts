import { type Cause, Effect, Exit, Fiber, ManagedRuntime, Scope, Stream } from 'effect';
import {
  cloneSession,
  continueSession,
  type ModelEvent,
  openSession,
  type SessionHandle,
  type Turn,
} from '@kilocode/harness-sdk';
import { type SQLiteDatabase } from 'expo-sqlite';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
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

/** What a chat screen draws. */
export type ChatState = {
  readonly sessionId: string;
  readonly model: string;
  /** Every turn the store holds, oldest first. */
  readonly turns: readonly Turn[];
  /** The answer arriving right now, empty when none is. */
  readonly answering: string;
  readonly status: 'opening' | 'idle' | 'working';
  /**
   * A question with no answer: still being asked, or asked and nothing came
   * back. `status` tells the two apart, and an idle chat holding one is what
   * puts a Retry under the last thing the person said.
   */
  readonly asked: string | null;
  /** Why the last question ended with no answer, for the log rather than the screen. */
  readonly failed: string | null;
};

const openRuntime = (database: SQLiteDatabase, org: ChatOrg) =>
  ManagedRuntime.make(chatLayers(database, org));

type ChatRuntime = ReturnType<typeof openRuntime>;

/** Every plugin the runtime holds, which is what a session may still ask for. */
type ChatContext = ManagedRuntime.ManagedRuntime.Context<ChatRuntime>;

/** A chat that is open: the session behind it, and what it is doing. */
type Chat = {
  readonly handle: SessionHandle;
  readonly scope: Scope.CloseableScope;
  answering: Fiber.RuntimeFiber<void, unknown> | undefined;
  readonly chatScope: string;
  readonly org: ChatOrg;
};

/** Where a chat belongs, which every call needs and no chat holds before it opens. */
export type ChatPlace = {
  readonly chatScope: string;
  readonly org: ChatOrg;
};

const chats = new Map<string, Chat>();

/**
 * What every chat looks like, open or not.
 *
 * It is kept apart from the sessions above so a screen can subscribe to a chat
 * before it has opened and read the same object every time it asks: a snapshot
 * built fresh on each read would tell React the screen had changed, forever.
 */
const states = new Map<string, ChatState>();

const watchers = new Map<string, Set<() => void>>();

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

const NOTHING = {
  turns: [] as readonly Turn[],
  answering: '',
  asked: null,
  failed: null,
} satisfies Omit<ChatState, 'sessionId' | 'model' | 'status'>;

function publish(sessionId: string): void {
  for (const watcher of watchers.get(sessionId) ?? []) {
    watcher();
  }
}

function change(sessionId: string, into: Partial<ChatState>): void {
  states.set(sessionId, { ...snapshotOf(sessionId), ...into });
  publish(sessionId);
}

/** The state a screen draws, whether or not the chat has opened yet. */
export function snapshotOf(sessionId: string): ChatState {
  const held = states.get(sessionId);
  if (held !== undefined) {
    return held;
  }
  const fresh: ChatState = { sessionId, model: '', status: 'opening', ...NOTHING };
  states.set(sessionId, fresh);
  return fresh;
}

export function watch(sessionId: string, watcher: () => void): () => void {
  const held = watchers.get(sessionId) ?? new Set<() => void>();
  held.add(watcher);
  watchers.set(sessionId, held);
  return () => {
    held.delete(watcher);
  };
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

/** Starts a chat: a session of its own, and a row so the list has it. */
export async function startChat(place: ChatPlace, model: string): Promise<string> {
  const runtime = await runtimeFor(place);
  const { handle, scope } = await inOwnScope(runtime, openSession({ system: SYSTEM, model }));
  rememberChat(await open(), { sessionId: handle.id, scope: place.chatScope, at: Date.now() });
  chats.set(handle.id, { handle, scope, answering: undefined, ...place });
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
  chats.set(sessionId, { handle, scope, answering: undefined, ...place });
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
}

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

/** A short reason for the log. The screen says the same thing whatever it is. */
function why(cause: Cause.Cause<unknown>): string {
  return cause.toString().slice(0, 200);
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
  change(sessionId, {
    turns,
    answering: '',
    status: 'idle',
    asked: failed === null ? null : snapshotOf(sessionId).asked,
    failed,
  });
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
  states.delete(sessionId);
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
  if (chat?.answering === undefined) {
    return;
  }
  const runtime = await runtimeFor(chat);
  await runtime.runPromise(Fiber.interrupt(chat.answering));
  chat.answering = undefined;
  change(sessionId, { status: 'idle', answering: '' });
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
  await stopChat(sessionId);
  const runtime = await runtimeFor(chat);
  await runtime.runPromise(Scope.close(chat.scope, Exit.void));
  chats.delete(sessionId);
  states.delete(sessionId);
}

/** Ends every chat, which is what signing out does before the wipe. */
export async function releaseEveryChat(): Promise<void> {
  for (const sessionId of chats.keys()) {
    // eslint-disable-next-line no-await-in-loop -- one scope closes after another: the store has no lock, and two closes at once would write over each other
    await releaseChat(sessionId);
  }
}
