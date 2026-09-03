import { Chunk, Effect } from 'effect';
import { IdGenerator } from './id.js';
import type { Turn } from './turn.js';

/**
 * A session is one conversation between a user and an agent. Everything else
 * plugs into it. The turns are append only: an earlier turn is never rewritten,
 * because a rewrite changes the prompt prefix and drops the model cache.
 */
interface Session {
  readonly id: string;
  readonly turns: Chunk.Chunk<Turn>;
}

const idPrefix = 'ses';

/** Makes an empty session. The `IdGenerator` plugin makes the identifier. */
const makeSession = (): Effect.Effect<Session, never, IdGenerator> =>
  IdGenerator.pipe(
    Effect.flatMap(generator => generator.generate(idPrefix)),
    Effect.map(id => ({ id, turns: Chunk.empty<Turn>() }))
  );

/** Appends a turn. `Chunk` shares the earlier turns, so nothing is copied. */
const appendTurn = (session: Session, turn: Turn): Session => ({
  ...session,
  turns: Chunk.append(session.turns, turn),
});

export type { Session };
export { appendTurn, makeSession };
