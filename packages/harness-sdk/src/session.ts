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

/** Makes a session. The `IdGenerator` plugin makes the identifier. */
const make = (): Effect.Effect<Session, never, IdGenerator> =>
  IdGenerator.pipe(
    Effect.flatMap(generator => generator.generate(idPrefix)),
    Effect.map(id => ({ id }))
  );

export type { Session };
export { idPrefix, make };
