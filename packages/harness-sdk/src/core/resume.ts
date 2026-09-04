import { Data, Effect, Option } from 'effect';
import { EntropySource, type EntropySourceService } from './entropy.js';
import { makeSession } from './session.js';
import {
  SessionStore,
  type SessionStoreService,
  type StoredSession,
  type StoreError,
} from './storage.js';
import { draftOf, makeTurn, type Turn } from './turn.js';
import {
  handleOf,
  type SessionContext,
  type SessionHandle,
  type SessionOptions,
  wiringFor,
} from './wiring.js';

/** The store holds no session under that identifier. */
class SessionNotFoundError extends Data.TaggedError('harness/SessionNotFoundError')<{
  readonly sessionId: string;
}> {}

/** Everything a resumed session needs. A store is required, not optional. */
type ResumeContext = SessionContext | SessionStore;

type ResumeError = StoreError | SessionNotFoundError;

/** What the session was opened with, as `wiringFor` wants it. */
const optionsOf = (stored: StoredSession): SessionOptions => ({
  system: stored.system,
  model: stored.model,
  ...(stored.effort === undefined ? {} : { effort: stored.effort }),
  ...(stored.maxTokens === undefined ? {} : { maxTokens: stored.maxTokens }),
});

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
    return handleOf(yield* wiringFor(optionsOf(stored), { id: sessionId, turns }, stored.prompted));
  });

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
  }
): Effect.Effect<readonly Turn[], StoreError> =>
  Effect.forEach(into.source, turn =>
    makeTurn(entropy, {
      sessionId: into.sessionId,
      role: turn.role,
      parts: turn.parts.map(draftOf),
    })
  ).pipe(
    Effect.tap(copies =>
      store.append({ sessionId: into.sessionId, turns: copies, prompted: into.prompted })
    )
  );

/**
 * Opens a new session holding a copy of another session's turns.
 *
 * The two sessions then diverge: a question asked of one leaves the other
 * alone. This is how a conversation is branched without paying to build its
 * prefix again.
 */
const cloneSession = (
  sessionId: string
): Effect.Effect<SessionHandle, ResumeError, ResumeContext> =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const entropy = yield* EntropySource;
    const stored = yield* storedOf(store, sessionId);
    const source = yield* store.load(sessionId);
    const opened = yield* makeSession(entropy);
    const options = optionsOf(stored);
    const prompted = stored.prompted ?? 0;
    yield* store.create({ ...options, id: opened.id, prompted });
    const turns = yield* copyTurns(store, entropy, { sessionId: opened.id, source, prompted });
    return handleOf(yield* wiringFor(options, { id: opened.id, turns }, prompted));
  });

export type { ResumeContext, ResumeError };
export { cloneSession, continueSession, SessionNotFoundError };
