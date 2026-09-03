import { Effect } from 'effect';
import { IdGenerator } from './id.js';

/**
 * A session is one conversation between a user and an agent. Everything else
 * plugs into it. This construct holds the identity and nothing more.
 */
interface Session {
  readonly id: string;
}

const idPrefix = 'ses';

/** Makes a session. Without an identifier, the `IdGenerator` plugin makes one. */
const make = (id?: string): Effect.Effect<Session, never, IdGenerator> =>
  id === undefined
    ? IdGenerator.pipe(
        Effect.flatMap(generator => generator.generate(idPrefix)),
        Effect.map(generated => ({ id: generated }))
      )
    : Effect.succeed({ id });

export type { Session };
export { idPrefix, make };
