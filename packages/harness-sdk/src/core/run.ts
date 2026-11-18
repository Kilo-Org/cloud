import { Effect } from 'effect';
import { EntropySource } from './entropy.js';
import { makeSession } from './session.js';
import { onStore, type StoreError } from './storage.js';
import type { ToolMissingError } from './tool.js';
import { handleOf, type SessionHandle } from './handle.js';
import { type SessionContext, type SessionOptions, wiringFor } from './wiring.js';

/**
 * Opens a new session and, when a store is in the context, records it.
 *
 * The record is written before the first question, so a session that is
 * interrupted mid-answer can still be found afterwards. Without a store the
 * session runs in memory and cannot be continued.
 */
const openSession = (
  options: SessionOptions
): Effect.Effect<SessionHandle, StoreError | ToolMissingError, SessionContext> =>
  Effect.gen(function* () {
    const entropy = yield* EntropySource;
    const opened = yield* makeSession(entropy);
    const wiring = yield* wiringFor(options, opened);
    yield* onStore(wiring.store, plugin => plugin.create({ ...options, id: opened.id }));
    return yield* handleOf(wiring);
  });

export { openSession };
