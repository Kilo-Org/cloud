import { Chunk, Effect } from 'effect';
import type { EntropySourceService } from './entropy.js';
import { makeId } from './id.js';
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

/** Makes an empty session. */
const makeSession = (entropy: EntropySourceService): Effect.Effect<Session> =>
  Effect.map(makeId(entropy, idPrefix), id => ({ id, turns: Chunk.empty<Turn>() }));

/** Appends a turn. `Chunk` shares the earlier turns, so nothing is copied. */
const appendTurn = (session: Session, turn: Turn): Session => ({
  ...session,
  turns: Chunk.append(session.turns, turn),
});

/**
 * The turns a prompt is built from: everything from the last summary onward.
 *
 * Compaction replaces the conversation with a summary and replays nothing
 * before it. Keeping the earlier turns and only summarising the old ones is the
 * shape that breaks: a thinking block was signed against the whole history that
 * stood when it was made, so replaying it after a summary is refused.
 *
 * The earlier turns are still in memory and still in the store. They are the
 * record of what happened; they are simply not what the model is asked with.
 */
const sinceSummary = (turns: Chunk.Chunk<Turn>): readonly Turn[] => {
  const all = Chunk.toReadonlyArray(turns);
  const at = all.findLastIndex(turn => turn.parts.some(part => part.kind === 'summary'));
  return at <= 0 ? all : all.slice(at);
};

export type { Session };
export { appendTurn, makeSession, sinceSummary };
