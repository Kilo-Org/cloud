import { Data, Effect, Option } from 'effect';
import { EntropySource, type EntropySourceService } from './entropy.js';
import type { Effort } from './model.js';
import { makeSession } from './session.js';
import {
  SessionStore,
  type SessionStoreService,
  type StoredSession,
  type StoreError,
} from './storage.js';
import type { ToolMissingError } from './tool.js';
import { draftOf, makeTurn, type PartDraft, type Turn } from './turn.js';
import { handleOf, type SessionHandle } from './handle.js';
import { type SessionContext, type SessionOptions, wiringFor } from './wiring.js';

/** The store holds no session under that identifier. */
class SessionNotFoundError extends Data.TaggedError('harness/SessionNotFoundError')<{
  readonly sessionId: string;
}> {}

/** Everything a resumed session needs. A store is required, not optional. */
type ResumeContext = SessionContext | SessionStore;

type ResumeError = StoreError | SessionNotFoundError | ToolMissingError;

/** What the session was opened with, as `wiringFor` wants it. */
const optionsOf = (stored: StoredSession): SessionOptions => ({
  system: stored.system,
  model: stored.model,
  ...(stored.effort === undefined ? {} : { effort: stored.effort }),
  ...(stored.maxTokens === undefined ? {} : { maxTokens: stored.maxTokens }),
  ...(stored.tools === undefined ? {} : { tools: stored.tools }),
});

/**
 * What a clone may be opened with instead of what the store holds.
 *
 * These two and nothing else, because these two are why a caller clones rather
 * than continues: a session freezes its model and its effort for the life of
 * the cached prefix, so moving a conversation to another model is a copy of it.
 * Everything else still comes from the store, and for the usual reason: a
 * system prompt that differs by one byte drops the whole prefix.
 */
interface CloneOptions {
  readonly model?: string;
  readonly effort?: Effort;
}

const storedOf = (
  store: SessionStoreService,
  sessionId: string
): Effect.Effect<StoredSession, ResumeError> =>
  Effect.flatMap(
    store.read(sessionId),
    Option.match({
      onNone: () => Effect.fail(new SessionNotFoundError({ sessionId })),
      onSome: (stored: StoredSession) => Effect.succeed(stored),
    })
  );

/**
 * Reopens a session the store already holds.
 *
 * The options come from the store, never from the caller. A system prompt that
 * differs by one byte from the one the session was opened with would drop the
 * whole cached prefix on the first question, and the only symptom is the bill.
 */
const continueSession = (
  sessionId: string
): Effect.Effect<SessionHandle, ResumeError, ResumeContext> =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const stored = yield* storedOf(store, sessionId);
    const turns = yield* store.load(sessionId);
    const wiring = yield* wiringFor(optionsOf(stored), { id: sessionId, turns }, stored.prompted);
    return yield* handleOf(wiring);
  });

/**
 * The stored options with what the caller is moving the copy onto. A field the
 * caller left out is the stored one: `undefined` here means "as it was", never
 * "unset it".
 */
const movedOnto = (options: SessionOptions, onto: CloneOptions | undefined): SessionOptions => ({
  ...options,
  ...(onto?.model === undefined ? {} : { model: onto.model }),
  ...(onto?.effort === undefined ? {} : { effort: onto.effort }),
});

/**
 * The parts of one turn a copy may carry.
 *
 * All of them, unless the copy runs on another model. A thinking block is
 * signed by the model that made it and read back by the same one, so it is the
 * one thing that cannot move: what the model said, the images it was shown, and
 * the tools it called all replay anywhere, and its thinking replays nowhere
 * else. The conversation is unchanged by dropping it — a summary of its own
 * reasoning is not what the next model is asked to build on.
 */
const replayable = (turn: Turn, moved: boolean): readonly PartDraft[] =>
  turn.parts
    .filter(part => !moved || (part.kind !== 'reasoning' && part.kind !== 'redacted'))
    .map(draftOf);

/**
 * Copies the turns onto a new session, in order.
 *
 * Each copy is a new turn with new parts, because an identifier names one row
 * and carries its order. The content is unchanged, and the content is what the
 * model sees, so the copy renders to the same bytes and inherits the warm
 * cache.
 */
const copyTurns = (
  store: SessionStoreService,
  entropy: EntropySourceService,
  into: {
    readonly sessionId: string;
    readonly source: readonly Turn[];
    /** The source's count: the copy renders to the same bytes, so it is as full. */
    readonly prompted: number;
    /** True when the copy runs on another model, which is what drops thinking. */
    readonly moved: boolean;
  }
): Effect.Effect<readonly Turn[], StoreError> =>
  Effect.forEach(into.source, turn =>
    makeTurn(entropy, {
      sessionId: into.sessionId,
      role: turn.role,
      parts: replayable(turn, into.moved),
    })
  ).pipe(
    Effect.tap(copies =>
      store.append({ sessionId: into.sessionId, turns: copies, prompted: into.prompted })
    )
  );

/** The turns to copy, and what the copy must know about them. */
interface Copying {
  readonly source: readonly Turn[];
  readonly moved: boolean;
  readonly prompted: number;
}

/** Records the copy, writes its turns, and hands back the handle over them. */
const copyOnto = (
  store: SessionStoreService,
  options: SessionOptions,
  from: Copying
): Effect.Effect<SessionHandle, StoreError | ToolMissingError, SessionContext> =>
  Effect.gen(function* () {
    const entropy = yield* EntropySource;
    const opened = yield* makeSession(entropy);
    const { prompted } = from;
    yield* store.create({ ...options, id: opened.id, prompted });
    const turns = yield* copyTurns(store, entropy, { sessionId: opened.id, ...from });
    return yield* handleOf(yield* wiringFor(options, { id: opened.id, turns }, prompted));
  });

/**
 * Opens a new session holding a copy of another session's turns.
 *
 * The two sessions then diverge: a question asked of one leaves the other
 * alone. This is how a conversation is branched without paying to build its
 * prefix again, and — with `onto` — how one moves to another model at all.
 *
 * The count comes across with the turns, so a copy of a conversation that
 * nearly fills the window compacts before its first question rather than after
 * it. On another model it is the source's number rather than the copy's own,
 * which the first answer replaces with the truth.
 */
const cloneSession = (
  sessionId: string,
  onto?: CloneOptions
): Effect.Effect<SessionHandle, ResumeError, ResumeContext> =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const stored = yield* storedOf(store, sessionId);
    const source = yield* store.load(sessionId);
    const options = movedOnto(optionsOf(stored), onto);
    return yield* copyOnto(store, options, {
      source,
      moved: options.model !== stored.model,
      prompted: stored.prompted ?? 0,
    });
  });

export type { CloneOptions, ResumeContext, ResumeError };
export { cloneSession, continueSession, SessionNotFoundError };
