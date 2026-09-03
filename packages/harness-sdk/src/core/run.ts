import { Effect } from 'effect';
import { onStore } from './ask.js';
import { EntropySource } from './entropy.js';
import { makeSession } from './session.js';
import type { StoreError } from './storage.js';
import {
  handleOf,
  type SessionContext,
  type SessionHandle,
  type SessionOptions,
  wiringFor,
} from './wiring.js';

/**
 * Opens a new session and, when a store is in the context, records it.
 *
 * The record is written before the first question, so a session that is
 * interrupted mid-answer can still be found afterwards. Without a store the
 * session runs in memory and cannot be continued.
 */
const openSession = (
  options: SessionOptions
): Effect.Effect<SessionHandle, StoreError, SessionContext> =>
  Effect.gen(function* () {
    const entropy = yield* EntropySource;
    const opened = yield* makeSession(entropy);
    const wiring = yield* wiringFor(options, opened);
    yield* onStore(wiring.store, plugin => plugin.create({ ...options, id: opened.id }));
    return handleOf(wiring);
  });

export { openSession };
