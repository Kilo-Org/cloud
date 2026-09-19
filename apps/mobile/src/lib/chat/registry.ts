/* eslint-disable max-lines -- the registry owns the live chats: opening one, answering in it, moving it onto another model or tool set, and releasing it all share one map of running sessions, so the operations stay together. */
import { Cause, Effect, Exit, Fiber, ManagedRuntime, Option, Scope, Stream } from 'effect';
import {
  cloneSession,
  continueSession,
  type ModelEvent,
  openSession,
  type SessionHandle,
  ToolMissingError,
} from '@kilocode/harness-sdk';
import { type SQLiteDatabase } from 'expo-sqlite';

import { KILO_MCP_URL } from '@/lib/config';
import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { change, forgetState, moveState, NOTHING, snapshotOf } from './state';
import { chatLayers, type ChatOrg } from './layers';
import {
  ensureKiloMcp,
  mcpEnabledFor,
  moveMcpEnabled,
  setMcpEnabled as persistMcpEnabled,
} from './kilo-mcp';
import { type ChatPlace } from './scope';
import { askedIn, forgetAsked, moveAsked, rememberAsked } from './pending';
import { chatToolNames } from './tools';
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
  /**
   * A Kilo MCP choice made while an answer was arriving, applied when it
   * settles. The tool set is frozen for the life of a session, so it is never
   * changed under an answer that is still coming.
   */
  pendingMcp: boolean | undefined;
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
  try {
    const handle = await runtime.runPromise(Scope.extend(opened, scope));
    return { handle, scope };
  } catch (error) {
    /* Opening the session failed after the scope was made, and every caller
       releases a chat by closing the scope it got. Nobody got one, so the
       finalizers the half-open session registered would never run. */
    await runtime.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

/**
 * The system prompt, frozen for the life of every session and identical across
 * them. It is the front of the cached prefix, so it is one constant here and is
 * never built out of anything that varies.
 */
const SYSTEM =
  'You are Kilo, a helpful assistant inside a mobile app. ' +
  'Answer briefly and in plain language, in the language the person writes in. ' +
  'Your one tool tells you the date and time; the date you were trained on has ' +
  'passed, so read the clock rather than assuming it. You have no files and no ' +
  'internet: when something needs one of those, say so rather than guessing. ' +
  'Use markdown sparingly, and code blocks for code.';

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

/**
 * Starts a chat: a session of its own, and a row so the list has it.
 *
 * A new chat has the Kilo MCP on unless the caller says otherwise, because the
 * server is available to any signed-in account and there is no setting yet for
 * a chat that does not exist. When it is on, the tools are discovered before
 * the session opens so it can name them — bounded at four seconds, and a
 * failure still opens the chat on the base tools rather than holding the send
 * on the server.
 */
export async function startChat(
  place: ChatPlace,
  model: string,
  mcpEnabled = true
): Promise<string> {
  const runtime = await runtimeFor(place);
  if (mcpEnabled && KILO_MCP_URL !== undefined) {
    await ensureKiloMcp(place, 'automatic');
  }
  const { handle, scope } = await inOwnScope(
    runtime,
    openSession({ system: SYSTEM, model, tools: chatToolNames(mcpEnabled) })
  );
  rememberChat(await open(), { sessionId: handle.id, scope: place.chatScope, at: Date.now() });
  if (!mcpEnabled) {
    /* The chat was opened without the tools, so its setting says so: a chat
       that never had them is still a chat a person can turn them on for. */
    await persistMcpEnabled(handle.id, false);
  }
  chats.set(handle.id, {
    handle,
    scope,
    answering: undefined,
    waiting: [],
    pendingMcp: undefined,
    ...place,
  });
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
  /* A route can name the id a chat moved off, and reading it resolves to the
     chat that carried on. Opening the moved-off id would reopen a session the
     move already deleted and report its failure onto the live chat. */
  const followed = snapshotOf(sessionId).sessionId;
  if (followed !== sessionId) {
    await enterChat(place, followed);
    return;
  }
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
    } catch (error) {
      /* Opening the store, the session, or its history can fail. The chat is
         not left saying it is opening with the rejection swallowing it: it
         settles idle with the reason, so entering it again is possible rather
         than a screen that spins forever. */
      change(sessionId, { status: 'idle', failed: openReason(error) });
    } finally {
      opening.delete(sessionId);
    }
  })();
  opening.set(sessionId, work);
  await work;
}

/**
 * Reopens the stored session, answering whether its names still resolve.
 *
 * A session that names a tool the registry no longer holds fails here rather
 * than opening: the names are frozen for the life of a session, so the caller
 * moves the chat onto the names it holds now instead. Reading the failure out
 * of the exit is what tells that case from every other way an open can fail —
 * a thrown failure is wrapped by the runtime and loses its type.
 */
async function continueOrMissing(
  runtime: ChatRuntime,
  sessionId: string
): Promise<
  | { readonly opened: false }
  | { readonly opened: true; readonly handle: SessionHandle; readonly scope: Scope.CloseableScope }
> {
  const scope = await runtime.runPromise(Scope.make());
  const exit = await runtime.runPromise(
    Effect.exit(Scope.extend(continueSession(sessionId), scope))
  );
  if (Exit.isSuccess(exit)) {
    return { opened: true, handle: exit.value, scope };
  }
  /* Opening failed after the scope was made; with nothing holding it, only
     closing it runs the finalizers the half-open session registered. */
  await runtime.runPromise(Scope.close(scope, Exit.void));
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (failure instanceof ToolMissingError) {
    return { opened: false };
  }
  throw failure instanceof Error ? failure : new Error(Cause.pretty(exit.cause).slice(0, 300));
}

async function reopen(place: ChatPlace, sessionId: string): Promise<void> {
  const runtime = await runtimeFor(place);
  const enabled = await mcpEnabledFor(sessionId);
  if (enabled && KILO_MCP_URL !== undefined) {
    /* An open, so the four-second bound: a server that is slow or down leaves
       the chat opening on the base tools rather than holding it here. */
    await ensureKiloMcp(place, 'automatic');
  }
  /* The stored names are what the session was opened with, and a continued
     session may not change them. Discovering the server first is what makes
     them resolve again after a restart. */
  const opened = await continueOrMissing(runtime, sessionId);
  if (!opened.opened) {
    /* The stored names no longer resolve: the server's tool list moved on, or
       the server is down while the session was stored with its tools. The chat
       opens either way, on the names the registry holds now. */
    const current = await onto(place, sessionId, { tools: chatToolNames(enabled) });
    const model = modelOfSession(await open(), current) ?? '';
    const asked = await askedIn(current);
    change(current, { model, asked, status: 'idle' });
    return;
  }
  const { handle, scope } = opened;
  try {
    const turns = await runtime.runPromise(handle.history);
    const asked = await askedIn(sessionId);
    const model = modelOfSession(await open(), sessionId) ?? '';
    chats.set(sessionId, {
      handle,
      scope,
      answering: undefined,
      waiting: [],
      pendingMcp: undefined,
      ...place,
    });
    change(sessionId, {
      ...NOTHING,
      model,
      turns,
      status: 'idle',
      asked,
    });
  } catch (error) {
    /* Reading the history or the pending question failed after the session
       opened. The screen settles idle with the reason, so entering the chat
       again is possible — but the session this open made is not one anything
       holds, so its scope is closed here or it leaks. */
    await runtime.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

/**
 * Says something and reads the answer as it arrives.
 *
 * A model that is not the one the session was opened on moves the conversation
 * first, because a session freezes its model. The identifier changes when it
 * does, and the state of the chat it moved off says where it went, so whoever
 * is watching follows without being told.
 */
export async function say(sessionId: string, text: string, model: string): Promise<void> {
  /* Where the failure below belongs. It is the chat the move landed on, not
     the one it started from, or the report goes to a chat nobody is watching. */
  let current = sessionId;
  try {
    /* A person can type before the session has finished opening, and a
       question asked of a chat that is not there yet used to vanish with the
       composer reporting success. It waits for the open instead. */
    await opening.get(sessionId);
    const held = chats.get(sessionId);
    if (held?.answering !== undefined) {
      /* A session answers one question at a time, and the composer stays open
         while it works. So a second question joins the line rather than racing
         the first, and it is on screen while it waits. It is held in memory
         only: an answer that is still arriving is not written down either. */
      held.waiting.push({ text, model });
      change(sessionId, { waiting: held.waiting.map(one => one.text) });
      return;
    }
    current = await ontoModel(sessionId, model);
    const chat = chats.get(current);
    if (chat === undefined) {
      throw new Error('the chat is not open');
    }
    const runtime = await runtimeFor(chat);
    await rememberAsked(current, text);
    touchChat(await open(), current, Date.now());
    change(current, { status: 'working', answering: '', asked: text, failed: null });
    chat.answering = runtime.runFork(reading(current, text, runtime));
  } catch (error) {
    /* The open, the move, or the write that remembers the question failed. The
       question is not lost: it stays on screen with a Retry under it, the same
       as one whose answer never arrived. */
    change(current, { status: 'idle', answering: '', asked: text, failed: reason(error) });
  }
}

/** A short reason for the log, from something thrown rather than from a cause. */
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : 'the question could not be sent';

/** The same, for a chat that could not be reopened. */
const openReason = (error: unknown): string =>
  error instanceof Error ? error.message : 'the chat could not be opened';

/** Asks again what was asked and never answered. */
export async function retryChat(sessionId: string): Promise<void> {
  const { asked, model } = snapshotOf(sessionId);
  if (asked !== null) {
    await say(sessionId, asked, model);
  }
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
     off — so what is waiting stays waiting until the person deals with it. A
     Kilo MCP choice made while the answer was arriving is different: it is
     applied either way, because the answer is no longer arriving. */
  await drain(sessionId, chat, failed !== null);
}

/**
 * Applies what was left while the answer was arriving: a Kilo MCP choice, then
 * the next question the person asked.
 *
 * They typed the question while the last answer was arriving, so it was never a
 * draft they could go back and change: it is a question they asked, and it is
 * asked as soon as the session is free. A question that failed keeps its Retry,
 * so only a question whose answer landed is asked here.
 */
async function drain(sessionId: string, chat: Chat, failed: boolean): Promise<void> {
  let current = sessionId;
  if (chat.pendingMcp !== undefined) {
    chat.pendingMcp = undefined;
    current = await ontoTools(current, chat);
  }
  if (failed) {
    return;
  }
  const next = chat.waiting.shift();
  if (next === undefined) {
    return;
  }
  change(current, { waiting: chat.waiting.map(one => one.text) });
  await say(current, next.text, next.model);
}

/** What a chat can be moved onto: another model, another tool set, or both. */
type Onto = {
  readonly model?: string;
  readonly tools?: readonly string[];
};

/**
 * Moves the chat onto another model or another tool set, and answers with the
 * session to carry on with.
 *
 * The old session goes: the copy holds every turn of it, and two rows for one
 * conversation is a list that lies. What a copy cannot carry is the thinking,
 * which is signed by the model that made it — that rule is the SDK's, and this
 * only asks for the move. A tool set is not a model, so moving onto other tools
 * keeps the thinking.
 *
 * The chat may not be open yet: a stored session whose names no longer resolve
 * is moved by reopening it, and there is no live session to close or record.
 */
async function onto(place: ChatPlace, sessionId: string, move: Onto): Promise<string> {
  const chat = chats.get(sessionId);
  const held = snapshotOf(sessionId);
  const model = move.model === undefined || move.model === '' ? held.model : move.model;
  const wanted: Onto = {
    ...(model === held.model ? {} : { model }),
    ...(move.tools === undefined ? {} : { tools: move.tools }),
  };
  if (wanted.model === undefined && wanted.tools === undefined) {
    return sessionId;
  }
  const runtime = await runtimeFor(chat ?? place);
  const { handle, scope } = await inOwnScope(runtime, cloneSession(sessionId, wanted));
  const database = await open();
  moveChat(database, { from: sessionId, to: handle.id, at: Date.now() });
  await moveAsked(sessionId, handle.id);
  await moveMcpEnabled(sessionId, handle.id);
  const turns = await runtime.runPromise(handle.history);
  chats.delete(sessionId);
  chats.set(
    handle.id,
    chat === undefined
      ? { handle, scope, answering: undefined, waiting: [], pendingMcp: undefined, ...place }
      : { ...chat, handle, scope, answering: undefined }
  );
  change(handle.id, { ...held, sessionId: handle.id, model, turns });
  /* The chat it moved off is left pointing at the one it became, rather than
     forgotten. Whoever asked for the move is not always the screen — a question
     queued on another model moves the chat from inside the registry — so the
     state is what says where the conversation went. It is only the pointer: a
     screen reading the old id resolves to the session that carried on, so the
     transcript is never cleared and no second copy is kept. */
  moveState(sessionId, handle.id);
  if (chat !== undefined) {
    await runtime.runPromise(Scope.close(chat.scope, Exit.void));
  }
  forgetSession(database, sessionId);
  return handle.id;
}

/**
 * Moves the chat onto the model the person picked, and answers with the session
 * to carry on with.
 */
async function ontoModel(sessionId: string, model: string): Promise<string> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return sessionId;
  }
  const carried = await onto(chat, sessionId, { model });
  return carried;
}

/**
 * Moves the chat onto the tool set its Kilo MCP setting names now.
 *
 * A session freezes the tools it offers, so turning the server off is a move
 * onto a session without its tools, and turning it on is a move onto one with
 * them.
 */
async function ontoTools(sessionId: string, place: ChatPlace): Promise<string> {
  return onto(place, sessionId, { tools: chatToolNames(await mcpEnabledFor(sessionId)) });
}

/**
 * Turns the Kilo MCP tools on or off for one chat.
 *
 * The setting is written first, so it survives whatever happens to the session.
 * Turning it on reaches the server, because a chat that had the feature off
 * never ran a discovery: without asking, the session would be moved onto the
 * base tools alone, the sheet would still say the server is not available, and
 * the switch the person just turned on would snap back off. A chat that is
 * answering is not moved under the answer — the tool set would change between
 * two rounds of one question — so the choice is remembered and applied when the
 * answer settles.
 */
export async function setMcpEnabled(sessionId: string, enabled: boolean): Promise<void> {
  const current = snapshotOf(sessionId).sessionId;
  if ((await mcpEnabledFor(current)) === enabled) {
    return;
  }
  await persistMcpEnabled(current, enabled);
  const chat = chats.get(current);
  if (chat === undefined) {
    return;
  }
  if (enabled && KILO_MCP_URL !== undefined) {
    /* An open, so the four-second bound: a server that is slow or down leaves
       the chat to be moved onto what is known rather than holding the switch. */
    await ensureKiloMcp(chat, 'automatic');
  }
  if (chat.answering !== undefined) {
    chat.pendingMcp = enabled;
    return;
  }
  await ontoTools(current, chat);
}

/**
 * Asks the Kilo server again, and moves the chat onto the tools that answered.
 *
 * A Retry is a person asking, so it gets the longer deadline the module keeps
 * for one. The tool set is frozen for the life of a session, so tools that were
 * not there when the chat opened need a session that names them: the chat is
 * moved onto one, the way turning the setting on moves it. A server that still
 * refuses leaves the chat where it is, because the failure is already on screen
 * and a move onto the same tools would only churn the session.
 *
 * A chat that is answering is not moved under the answer, for the same reason
 * the setting is not: the tool set would change between two rounds of one
 * question. The recovered tools are applied when the answer settles, unless the
 * person turned the setting off while it was arriving.
 */
export async function retryKiloMcp(sessionId: string): Promise<void> {
  const current = snapshotOf(sessionId).sessionId;
  const chat = chats.get(current);
  if (chat === undefined) {
    return;
  }
  const state = await ensureKiloMcp(chat, 'retry');
  if (state.status !== 'ready' || state.tools.length === 0) {
    return;
  }
  if (chat.answering !== undefined) {
    chat.pendingMcp ??= true;
    return;
  }
  await ontoTools(current, chat);
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
    await drain(sessionId, chat, false);
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
 *
 * The id may be one a chat moved off — a route or a list row can still name it.
 * It resolves to the chat that carried on, or releasing it would leave that
 * chat running and the old id pointing at one nobody ended.
 */
export async function releaseChat(sessionId: string): Promise<void> {
  const current = snapshotOf(sessionId).sessionId;
  const chat = chats.get(current);
  if (chat === undefined) {
    /* Deleting a chat that was never opened still has a state subscribed by the
       row that was tapped, so it is forgotten here too. */
    forgetState(current);
    return;
  }
  await halt(current, chat);
  /* Whatever was still waiting goes with the chat. Asking it now would open a
     round on a session whose scope is closing under it. */
  chat.waiting.length = 0;
  const runtime = await runtimeFor(chat);
  await runtime.runPromise(Scope.close(chat.scope, Exit.void));
  chats.delete(current);
  forgetState(current);
}

/** Ends every chat, which is what signing out does before the wipe. */
export async function releaseEveryChat(): Promise<void> {
  for (const sessionId of chats.keys()) {
    // eslint-disable-next-line no-await-in-loop -- one scope closes after another: the store has no lock, and two closes at once would write over each other
    await releaseChat(sessionId);
  }
}
