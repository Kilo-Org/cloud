/* eslint-disable max-lines -- the registry owns the live chats: opening one, answering in it, moving it onto another model or tool set, and releasing it all share one map of running sessions, so the operations stay together. */
import { Cause, Effect, Exit, Fiber, ManagedRuntime, Option, Scope, Stream } from 'effect';
import {
  type CloneOptions,
  cloneSession,
  continueSession,
  type Effort,
  type ModelEvent,
  type ModelUsage,
  openSession,
  type PartDraft,
  type SessionHandle,
  ToolMissingError,
} from '@kilocode/harness-sdk';
import { type SQLiteDatabase } from 'expo-sqlite';

import { KILO_MCP_URL } from '@/lib/config';
import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import {
  change,
  type ChatTarget,
  forgetState,
  moveState,
  NOTHING,
  type Question,
  snapshotOf,
} from './state';
import { chatLayers, type ChatOrg, organizationIdOf } from './layers';
import { answerParts } from './answer-parts';
import { countSessionUsage } from './chat-usage';
import {
  ensureKiloMcp,
  mcpEnabledFor,
  moveMcpEnabled,
  setMcpEnabled as persistMcpEnabled,
} from './kilo-mcp';
import { ensureRemoteMcp } from './remote-mcp';
import { type ChatPlace } from './scope';
import { questionSearches } from './web-search-budget';
import { askedIn, forgetAsked, migrateAsked, moveAsked, rememberAsked } from './pending';
import { chatToolNames, chatToolNamesStarting } from './tools';
import {
  moveWebSearchEnabled,
  setWebSearchEnabled as persistWebSearchEnabled,
  webSearchDefault,
} from './web-search-setting';
import { waitForChatBackends } from './backend-store';
import { targetSupportsTools } from './backend-capabilities';
import { backendFailureKey } from './backend-target';
import {
  effortOfSession,
  forgetSession,
  modelOfSession,
  moveChat,
  recordOfChat,
  recordUsage,
  rememberChat,
  toolsOfSession,
  touchChat,
} from './store';

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
type ChatContext = ManagedRuntime.ManagedRuntime.Services<ChatRuntime>;

/**
 * A question typed while an answer was arriving, and the model and effort it
 * was meant for. They are carried because a person can change them between the
 * two, and the question was asked of the ones that were on screen.
 */
type Waiting = Question & ChatTarget;

/** What the screen draws of the line: the questions, without the models they go to. */
const questionsIn = (waiting: readonly Waiting[]): readonly Question[] =>
  waiting.map(one => ({ text: one.text, images: one.images }));

/** A chat that is open: the session behind it, and what it is doing. */
type Chat = {
  readonly handle: SessionHandle;
  readonly scope: Scope.Closeable;
  answering: Fiber.Fiber<void, unknown> | undefined;
  /** What was typed while `answering` was running. Drained when it ends well. */
  readonly waiting: Waiting[];
  /**
   * A tool-set change made while an answer was arriving — the Kilo MCP switch,
   * the web search switch, a Retry, or the settings group switch — applied
   * when it settles. The tool set is frozen for the life of a session, so it is
   * never changed under an answer that is still coming.
   */
  pendingTools: boolean | undefined;
  /**
   * The session's own total when the chat's usage last took from it. The SDK
   * counts from zero each time a session opens, so a new session starts here
   * at zero too.
   */
  counted: ReadonlyMap<string, ModelUsage>;
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
  await waitForChatBackends();
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
): Promise<{ readonly handle: SessionHandle; readonly scope: Scope.Closeable }> {
  const scope = await runtime.runPromise(Scope.make());
  try {
    const handle = await runtime.runPromise(Scope.provide(opened, scope));
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
 * never built out of anything that varies — which is why it speaks of web
 * search as a tool that may or may not be offered.
 */
const SYSTEM =
  'You are Kilo, a helpful assistant inside a mobile app. ' +
  'Answer briefly and in plain language, in the language the person writes in. ' +
  'One tool tells you the date and time; the date you were trained on has ' +
  'passed, so read the clock rather than assuming it. When a web_search tool is ' +
  'offered, use it for anything that can have changed since you were trained, ' +
  'such as news, prices or schedules, and name the sources you used. Without it ' +
  'you have no internet, and you never have files: when something needs one of ' +
  'those, say so rather than guessing. ' +
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
 * Discovers the servers a chat opens with: the Kilo server when the chat uses
 * it, and the person's remote servers. Both run at once on an open's
 * four-second bound, so a slow or absent server leaves the chat opening on the
 * tools that answered rather than holding it. A restart keeps no discovered
 * tool, so without this an open after a restart would name no remote tool.
 */
async function discoverServers(place: ChatPlace, kiloEnabled: boolean): Promise<void> {
  await Promise.all([
    kiloEnabled && KILO_MCP_URL !== undefined ? ensureKiloMcp(place, 'automatic') : undefined,
    ensureRemoteMcp(place),
  ]);
}

/**
 * Starts a chat: a session of its own, and a row so the list has it.
 *
 * A new chat has the Kilo MCP on unless the caller says otherwise, because the
 * server is available to any signed-in account and there is no setting yet for
 * a chat that does not exist. The servers are discovered before the session
 * opens so it can name their tools — bounded at four seconds, and a failure
 * still opens the chat on the base tools rather than holding the send on a
 * server. The names come from the caller's choice rather than from a stored
 * setting, because a session opens before there is an id to read one.
 */
export async function startChat(
  place: ChatPlace,
  target: ChatTarget,
  mcpEnabled = true
): Promise<string> {
  const { model, effort } = target;
  const runtime = await runtimeFor(place);
  const toolsSupported = targetSupportsTools(model);
  if (toolsSupported) {
    await discoverServers(place, mcpEnabled);
  }
  const { handle, scope } = await inOwnScope(
    runtime,
    openSession({
      system: SYSTEM,
      model,
      ...(effort === null ? {} : { effort }),
      tools: toolsSupported
        ? chatToolNamesStarting(organizationIdOf(place.org), {
            kiloEnabled: mcpEnabled,
            webSearchEnabled: webSearchDefault(model),
          })
        : [],
    })
  );
  const database = await open();
  rememberChat(database, { sessionId: handle.id, scope: place.chatScope, at: Date.now() });
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
    pendingTools: undefined,
    counted: new Map(),
    ...place,
  });
  change(handle.id, {
    ...NOTHING,
    model,
    effort,
    status: 'idle',
    record: recordOfChat(database, handle.id),
  });
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
      change(sessionId, {
        status: 'idle',
        failed: openReason(error),
        failureKey: backendFailureKey(error),
      });
    } finally {
      opening.delete(sessionId);
    }
  })();
  opening.set(sessionId, work);
  await work;
}

/** A session that opened, or nothing when the names it was opened with no longer resolve. */
type Opened =
  | { readonly opened: false }
  | {
      readonly opened: true;
      readonly handle: SessionHandle;
      readonly scope: Scope.Closeable;
    };

/**
 * Opens a session in a scope of its own, answering nothing rather than throwing
 * when the names it was opened with no longer resolve.
 *
 * A session that names a tool the registry no longer holds fails here rather
 * than opening: the names are frozen for the life of a session, so the caller
 * moves the chat onto the names it holds now instead. Reading the failure out
 * of the exit is what tells that case from every other way an open can fail —
 * a thrown failure is wrapped by the runtime and loses its type.
 */
async function openOrMissing<E>(
  runtime: ChatRuntime,
  opened: Effect.Effect<SessionHandle, E, ChatContext | Scope.Scope>
): Promise<Opened> {
  const scope = await runtime.runPromise(Scope.make());
  const exit = await runtime.runPromise(Effect.exit(Scope.provide(opened, scope)));
  if (Exit.isSuccess(exit)) {
    return { opened: true, handle: exit.value, scope };
  }
  /* Opening failed after the scope was made; with nothing holding it, only
     closing it runs the finalizers the half-open session registered. */
  await runtime.runPromise(Scope.close(scope, Exit.void));
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (failure instanceof ToolMissingError) {
    return { opened: false };
  }
  throw failure instanceof Error ? failure : new Error(Cause.pretty(exit.cause).slice(0, 300));
}

async function reopen(place: ChatPlace, sessionId: string): Promise<void> {
  const runtime = await runtimeFor(place);
  const storedModel = modelOfSession(await open(), sessionId);
  if (storedModel !== null) {
    await migrateAsked(sessionId, storedModel);
  }
  /* An open, so the four-second bound: a server that is slow or down leaves the
     chat opening on the base tools rather than holding it here. The stored
     names are what the session was opened with, and a continued session may
     not change them. Discovering the servers first is what makes them resolve
     again after a restart. */
  await discoverServers(place, await mcpEnabledFor(sessionId));
  const opened = await openOrMissing(runtime, continueSession(sessionId));
  if (!opened.opened) {
    /* The stored names no longer resolve: the server's tool list moved on, or
       the server is down while the session was stored with its tools. The chat
       opens either way, on the names the registry holds now. */
    const current = await onto(place, sessionId, {
      tools: await chatToolNames(organizationIdOf(place.org), sessionId, storedModel ?? ''),
    });
    const database = await open();
    const asked = await askedIn(current);
    change(current, {
      model: modelOfSession(database, current) ?? '',
      effort: effortOfSession(database, current),
      asked: asked?.text ?? null,
      askedImages: asked?.images ?? [],
      askedModel: asked?.model ?? null,
      askedEffort: asked?.effort ?? null,
      status: 'idle',
      failed: null,
      failureKey: null,
      record: recordOfChat(database, current),
    });
    return;
  }
  const { handle, scope } = opened;
  try {
    const turns = await runtime.runPromise(handle.history);
    const asked = await askedIn(sessionId);
    const database = await open();
    chats.set(sessionId, {
      handle,
      scope,
      answering: undefined,
      waiting: [],
      pendingTools: undefined,
      counted: new Map(),
      ...place,
    });
    change(sessionId, {
      ...NOTHING,
      model: modelOfSession(database, sessionId) ?? '',
      effort: effortOfSession(database, sessionId),
      turns,
      status: 'idle',
      asked: asked?.text ?? null,
      askedImages: asked?.images ?? [],
      askedModel: asked?.model ?? null,
      record: recordOfChat(database, sessionId),
      askedEffort: asked?.effort ?? null,
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
 * A model or an effort that is not the one the session was opened on moves the
 * conversation first, because a session freezes both. The identifier changes
 * when it does, and the state of the chat it moved off says where it went, so
 * whoever is watching follows without being told.
 */
export async function say(
  sessionId: string,
  question: Question,
  target: ChatTarget
): Promise<void> {
  const { text, images } = question;
  const { model, effort } = target;
  /* Where the failure below belongs. It is the chat the move landed on, not
     the one it started from, or the report goes to a chat nobody is watching. */
  let current = snapshotOf(sessionId).sessionId;
  try {
    /* A person can type before the session has finished opening, and a
       question asked of a chat that is not there yet used to vanish with the
       composer reporting success. It waits for the open instead. */
    await opening.get(current);
    const held = chats.get(current);
    if (held?.answering !== undefined) {
      /* A session answers one question at a time, and the composer stays open
         while it works. So a second question joins the line rather than racing
         the first, and it is on screen while it waits. It is held in memory
         only: an answer that is still arriving is not written down either. */
      held.waiting.push({ text, images, model, effort });
      change(current, { waiting: questionsIn(held.waiting) });
      return;
    }
    /* One move, not two: the question is asked on the model on screen, and a
       switch that moved while the chat sat idle is applied in the same copy.
       The session freezes its tools, so the list sent to the model has to be
       the one the switches name at this moment. */
    if (held === undefined) {
      throw new Error('the chat is not open');
    }
    /* Remember the requested target before the move can fail. The live model
       stays unchanged until onto installs the session that actually moved. */
    change(current, { asked: text, askedImages: images, askedModel: model, askedEffort: effort });
    await rememberAsked(current, { text, model, effort, images });
    current = await ontoForUse(current, { model, effort }, held);
    const chat = chats.get(current);
    if (chat === undefined) {
      throw new Error('the chat is not open');
    }
    const runtime = await runtimeFor(chat);
    const at = Date.now();
    touchChat(await open(), current, at);
    change(current, {
      status: 'working',
      answering: [],
      asked: text,
      askedImages: images,
      askedModel: model,
      askedEffort: effort,
      failed: null,
      failureKey: null,
      record: { ...snapshotOf(current).record, updatedAt: at },
    });
    chat.answering = runtime.runFork(reading(current, { text, images }, runtime));
  } catch (error) {
    /* The open, the move, or the write that remembers the question failed. The
       question is not lost: it stays on screen with a Retry under it, the same
       as one whose answer never arrived. */
    /* onto may have installed the new session before its cleanup failed. */
    current = snapshotOf(current).sessionId;
    change(current, {
      status: 'idle',
      answering: [],
      asked: text,
      askedImages: images,
      askedModel: model,
      askedEffort: effort,
      failed: reason(error),
      failureKey: backendFailureKey(error),
    });
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
  const { sessionId: current, asked, askedImages, askedModel, askedEffort } = snapshotOf(sessionId);
  if (asked !== null && askedModel !== null) {
    await say(
      current,
      { text: asked, images: askedImages },
      { model: askedModel, effort: askedEffort }
    );
  } else {
    const chat = chats.get(current);
    if (chat !== undefined && chat.answering === undefined) {
      await drain(current, chat, false);
    }
  }
}

/**
 * What the session is asked. A question with images sends them first, the way
 * the major vision models read best, and an empty text part is left out.
 */
function partsOf({ text, images }: Question): string | readonly PartDraft[] {
  if (images.length === 0) {
    return text;
  }
  return [
    ...images.map((image): PartDraft => ({ kind: 'image', body: image.data, media: image.media })),
    ...(text === '' ? [] : [{ kind: 'text', body: text } as const]),
  ];
}

/** The tally stays in memory if persistence fails, so the next write includes it. */
async function countCall(
  sessionId: string,
  chat: Chat,
  call: {
    readonly total: ReadonlyMap<string, ModelUsage>;
    readonly last?: ModelUsage;
  }
): Promise<void> {
  const { total, last } = call;
  const { model, record } = snapshotOf(sessionId);
  const usage = countSessionUsage({
    usage: record.usage,
    requested: model,
    totals: total,
    counted: chat.counted,
  });
  chat.counted = total;
  if (usage === record.usage && last === undefined) {
    return;
  }
  change(sessionId, {
    record: {
      ...record,
      usage,
      prompted:
        last === undefined
          ? record.prompted
          : last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens + last.outputTokens,
    },
  });
  try {
    recordUsage(await open(), sessionId, usage);
  } catch {
    // The tally stays in memory and the next answer's write includes it.
  }
}

/** Reads one answer to the end, however it ends. */
function reading(sessionId: string, question: Question, runtime: ChatRuntime): Effect.Effect<void> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return Effect.void;
  }
  let parts = snapshotOf(sessionId).answering;
  const answer = chat.handle.ask(partsOf(question)).pipe(
    Stream.tap(event =>
      Effect.sync(() => {
        const next = answerParts({ sessionId, parts, event, now: Date.now() });
        if (next !== parts) {
          parts = next;
          change(sessionId, { answering: parts });
        }
      })
    )
  );
  return Stream.runForEach(answer, (event: ModelEvent) => {
    if (event.kind === 'done') {
      return chat.handle.usageByModel.pipe(
        Effect.flatMap(total =>
          Effect.promise(async () => {
            await countCall(sessionId, chat, { total, last: event.usage });
          })
        )
      );
    }
    return Effect.void;
  }).pipe(
    Effect.provideService(questionSearches, { used: 0 }),
    Effect.matchCauseEffect({
      onFailure: (cause: Cause.Cause<unknown>) =>
        Effect.promise(async () => {
          await settle(sessionId, runtime, {
            reason: why(cause),
            key: backendFailureKey(Option.getOrUndefined(Cause.findErrorOption(cause))),
          });
        }),
      onSuccess: () =>
        Effect.promise(async () => {
          await settle(sessionId, runtime, null);
        }),
    })
  );
}

/**
 * A short reason for the log. The screen shows fixed copy for the failure instead.
 *
 * The failure itself is read rather than the cause's own text: every error this
 * package raises is a tagged value whose fields — the status, the body, the
 * tool — are what say what happened, and none of them are in its message.
 */
function why(cause: Cause.Cause<unknown>): string {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
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
 * What is true once an answer has ended. A failure carries a reason for the log
 * and the key of the fixed copy the screen shows.
 *
 * The turns come from the session rather than from what was streamed: the store
 * holds what was written, and a question that failed was never written. That
 * question stays remembered, which is what offers the Retry.
 */
async function settle(
  sessionId: string,
  runtime: ChatRuntime,
  failure: { readonly reason: string; readonly key: string } | null
): Promise<void> {
  const chat = chats.get(sessionId);
  if (chat === undefined) {
    return;
  }
  const turns = await runtime.runPromise(chat.handle.history);
  await countCall(sessionId, chat, { total: await runtime.runPromise(chat.handle.usageByModel) });
  const failed = failure?.reason ?? null;
  if (failed === null) {
    await forgetAsked(sessionId);
  }
  chat.answering = undefined;
  change(sessionId, {
    turns,
    answering: [],
    status: 'idle',
    asked: failed === null ? null : snapshotOf(sessionId).asked,
    askedImages: failed === null ? [] : snapshotOf(sessionId).askedImages,
    askedModel: failed === null ? null : snapshotOf(sessionId).askedModel,
    failed,
    failureKey: failure?.key ?? null,
  });
  /* The line moves only when the answer landed. A question that failed keeps
     its Retry, and asking the next one would take the place that Retry hangs
     off — so what is waiting stays waiting until the person deals with it. A
     tool-set change made while the answer was arriving is different: it is
     applied either way, because the answer is no longer arriving. */
  await drain(sessionId, chat, failed !== null);
}

/**
 * Applies what was left while the answer was arriving: a tool-set change, then
 * the next question the person asked.
 *
 * They typed the question while the last answer was arriving, so it was never a
 * draft they could go back and change: it is a question they asked, and it is
 * asked as soon as the session is free. A question that failed keeps its Retry,
 * so only a question whose answer landed is asked here.
 */
async function drain(sessionId: string, chat: Chat, failed: boolean): Promise<void> {
  let current = sessionId;
  if (chat.pendingTools !== undefined) {
    chat.pendingTools = undefined;
    /* The names are computed from the switches as they stand now, so a choice
       made while the answer was arriving — the Kilo switch, a Retry, or the
       settings group switch — all land on the same recomputation. */
    try {
      current = await ontoTools(current, chat);
      if (!failed) {
        change(current, { failed: null, failureKey: null });
      }
    } catch (error) {
      /* A backend can change while its answer arrives. Keep the tool change
         and the whole line for an explicit retry or a new, valid target. */
      current = snapshotOf(current).sessionId;
      const held = chats.get(current);
      if (held !== undefined) {
        held.pendingTools = true;
      }
      change(current, { failed: reason(error), failureKey: backendFailureKey(error) });
      return;
    }
  }
  if (failed) {
    return;
  }
  const next = chat.waiting.shift();
  if (next === undefined) {
    return;
  }
  change(current, { waiting: questionsIn(chat.waiting) });
  await say(
    current,
    { text: next.text, images: next.images },
    { model: next.model, effort: next.effort }
  );
}

/** What a chat can be moved onto: another model, effort or tool set, or several. */
type Onto = {
  readonly model?: string;
  /** Null clears the effort, so the session asks with the model's default. */
  readonly effort?: Effort | null;
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
 *
 * A move onto another model keeps the tools the session was stored with, and
 * those can be names the registry has since dropped — a Kilo MCP call that did
 * not reach the server clears them — so the copy falls back to the names it
 * holds now rather than reporting the send as failed.
 */
async function onto(place: ChatPlace, sessionId: string, move: Onto): Promise<string> {
  const chat = chats.get(sessionId);
  const held = snapshotOf(sessionId);
  const model = move.model === undefined || move.model === '' ? held.model : move.model;
  const effort = move.effort === undefined ? held.effort : move.effort;
  const wanted: Onto = {
    ...(model === held.model ? {} : { model }),
    ...(effort === held.effort ? {} : { effort }),
    ...(move.tools === undefined ? {} : { tools: move.tools }),
  };
  if (wanted.model === undefined && wanted.effort === undefined && wanted.tools === undefined) {
    return sessionId;
  }
  const runtime = await runtimeFor(chat ?? place);
  const { handle, scope } = await cloneOnto(runtime, sessionId, {
    move: wanted,
    organizationId: organizationIdOf(place.org),
    model,
  });
  const database = await open();
  moveChat(database, { from: sessionId, to: handle.id, at: Date.now() });
  await moveAsked(sessionId, handle.id);
  await moveMcpEnabled(sessionId, handle.id);
  await moveWebSearchEnabled(sessionId, handle.id);
  const turns = await runtime.runPromise(handle.history);
  chats.delete(sessionId);
  chats.set(
    handle.id,
    chat === undefined
      ? {
          handle,
          scope,
          answering: undefined,
          waiting: [],
          pendingTools: undefined,
          counted: new Map(),
          ...place,
        }
      : { ...chat, handle, scope, answering: undefined, counted: new Map() }
  );
  /* The record describes the session the chat is now, and the move changed its
     effort: carrying the one it moved off would make the details sheet report
     the effort of a session the conversation is no longer on. */
  change(handle.id, {
    ...held,
    sessionId: handle.id,
    model,
    effort,
    turns,
    record: { ...held.record, effort },
  });
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
 * What a copy is made of: what to move onto, whose settings defaults to name,
 * and the model it lands on, which decides web search for a chat that never
 * chose.
 */
type Clone = {
  readonly move: Onto;
  readonly organizationId?: string;
  readonly model: string;
};

/**
 * Copies the session onto another model or tool set, on names the registry can
 * still resolve.
 *
 * A copy the caller gives no tools to keeps the ones the session was stored
 * with, and those can be the Kilo MCP tools the registry has since dropped: a
 * call that did not reach the server clears them, so the next move onto another
 * model would fail with `ToolMissingError` and the question would be reported
 * as failed rather than asked. The copy then names what the registry holds now,
 * which is the same fallback an open takes for a stored session whose names no
 * longer resolve.
 */
async function cloneOnto(
  runtime: ChatRuntime,
  sessionId: string,
  clone: Clone
): Promise<{ readonly handle: SessionHandle; readonly scope: Scope.Closeable }> {
  const { effort, ...move } = clone.move;
  const wanted: CloneOptions = {
    ...move,
    ...(effort === undefined ? {} : { effort: effort ?? 'default' }),
  };
  const cloned = await openOrMissing(runtime, cloneSession(sessionId, wanted));
  if (cloned.opened) {
    return cloned;
  }
  if (wanted.tools !== undefined) {
    /* The caller named the tools, so a name nothing holds is its own mistake
       rather than a stored set that moved on. */
    throw new Error('the chat was moved onto a tool the registry does not hold');
  }
  const tools = await chatToolNames(clone.organizationId, sessionId, clone.model);
  const again = await openOrMissing(runtime, cloneSession(sessionId, { ...wanted, tools }));
  if (!again.opened) {
    throw new Error('the chat names a tool the registry does not hold');
  }
  return again;
}

/**
 * Whether the names a session was opened with are the ones the switches name
 * now.
 *
 * A session freezes its tools, so this is what the live session still offers.
 * Reading it is how a chat already on the names is told from one that has to
 * move: a switch that changed another server's tools must not rewrite a chat
 * that names none of them, because a rewrite churns the session for nothing.
 */
async function holdsTools(sessionId: string, names: readonly string[]): Promise<boolean> {
  const held = toolsOfSession(await open(), sessionId);
  return (
    held !== null && held.length === names.length && held.every((name, i) => name === names[i])
  );
}

/**
 * The move a chat needs before its next question: onto the model and effort on
 * screen, and onto the names the switches name now.
 *
 * A session freezes its tools, so the list sent to the model is whatever this
 * chat was opened with until it is copied. When the store still holds those
 * names, they are compared with the switches as they stand — even if this chat
 * was not marked when the settings group switch moved — because an unmarked
 * chat would otherwise keep offering settings_set after the person turned it
 * off. A session the store has not written yet is left alone unless it was
 * marked: there are no names to compare, and copying it would churn every
 * first question. One move rather than two, because two would copy the
 * conversation twice and leave two rows for one chat. A chat already on the
 * names keeps its session.
 */
async function ontoForUse(sessionId: string, target: ChatTarget, chat: Chat): Promise<string> {
  const marked = chat.pendingTools !== undefined;
  chat.pendingTools = undefined;
  const names = targetSupportsTools(target.model)
    ? await chatToolNames(organizationIdOf(chat.org), sessionId, target.model)
    : [];
  const stored = toolsOfSession(await open(), sessionId);
  const already =
    stored !== null &&
    stored.length === names.length &&
    stored.every((name, i) => name === names[i]);
  const tools = already || (stored === null && !marked) ? undefined : names;
  return onto(chat, sessionId, {
    ...target,
    ...(tools === undefined ? {} : { tools }),
  });
}

/**
 * Moves the chat onto the tool set its switches name now.
 *
 * A session freezes the tools it offers, so a moved switch is a move onto a
 * session that names what is on now: the Kilo server turned off, a server's
 * enabled flag flipped, or the settings group switch moved. A chat already on
 * those names is left where it is — the switch that moved was not its own.
 */
async function ontoTools(sessionId: string, place: ChatPlace): Promise<string> {
  const { model } = snapshotOf(sessionId);
  const names = targetSupportsTools(model)
    ? await chatToolNames(organizationIdOf(place.org), sessionId, model)
    : [];
  if (await holdsTools(sessionId, names)) {
    return sessionId;
  }
  return onto(place, sessionId, { tools: names });
}

/**
 * Marks every open chat as naming the tool set the switches named before now.
 *
 * A session freezes the tools it was opened with, so flipping the settings
 * group switch, or a server's enabled flag, changes what the next session would
 * name and nothing about the one on screen. Marking is what makes the list sent
 * to the model move with the switch: each marked chat is moved onto the names
 * computed now at its next use — when a question is asked, or when the answer
 * it was arriving with settles.
 *
 * Nothing is moved here, and that is the bound. A chat stays open after its
 * screen closes, so the chats in this map are every chat visited in the run;
 * moving them all on one tap would copy each of them, and a switch that moved
 * one thing would pay for every chat ever opened. What is paid instead is the
 * chats a person actually uses, and a chat already on the names is not copied
 * even then.
 */
export async function refreshChatTools(): Promise<void> {
  for (const chat of chats.values()) {
    chat.pendingTools = true;
  }
  /* The marking is synchronous, and that is the point: the tap moves nothing.
     The promise is what lets the sheet await the tap finishing before it
     closes. */
  await Promise.resolve();
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
    chat.pendingTools = enabled;
    return;
  }
  await ontoTools(current, chat);
}

/**
 * Turns web search on or off for one chat.
 *
 * The choice is written first, so it survives whatever happens to the session,
 * and it is written even when it matches the model's default: from now on the
 * person's choice, not the model, decides. A chat that is answering is not
 * moved under the answer; the move is applied when the answer settles.
 */
export async function setWebSearchEnabled(sessionId: string, enabled: boolean): Promise<void> {
  const current = snapshotOf(sessionId).sessionId;
  await persistWebSearchEnabled(current, enabled);
  const chat = chats.get(current);
  if (chat === undefined) {
    return;
  }
  if (chat.answering !== undefined) {
    chat.pendingTools = true;
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
    chat.pendingTools ??= true;
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
  change(sessionId, { status: 'idle', answering: [] });
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
  for (const runtime of runtimes.values()) {
    // eslint-disable-next-line no-await-in-loop -- close each runtime after all of its sessions
    await runtime.dispose();
  }
  runtimes.clear();
}
