import { Effect } from 'effect';
import { monotonicFactory } from 'ulid';

/**
 * Makes an identifier of the form `{prefix}_{ulid}`.
 *
 * This is deliberately not a plugin point. The identifier must sort by the
 * order it was made in — a store rebuilds the prompt prefix in that order, and
 * a prefix in the wrong order misses the model cache. A plugin returning a
 * random identifier would typecheck, pass every test, and break that invariant
 * silently, one reload later. There is one right answer, so the package makes
 * it rather than asking.
 *
 * One module means one monotonic sequence. Two factories can hand out the same
 * millisecond twice, which is a flake that only shows up under load.
 */
const nextUlid = monotonicFactory();

const makeId = (prefix: string): Effect.Effect<string> =>
  Effect.sync(() => `${prefix}_${nextUlid()}`);

export { makeId };
