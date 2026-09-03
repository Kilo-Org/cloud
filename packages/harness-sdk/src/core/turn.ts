import { Effect } from 'effect';
import type { EntropySourceService } from './entropy.js';
import { makeId } from './id.js';

/**
 * One turn of a conversation. The shape is one SQLite row: flat, four columns,
 * no nesting and no join. The identifier is a monotonic ULID, so it is both the
 * primary key and the sort order; a separate timestamp column would repeat what
 * the identifier already holds.
 */
interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly role: TurnRole;
  readonly content: string;
}

type TurnRole = 'user' | 'assistant';

const idPrefix = 'trn';

/** What a turn is made of, before it has an identifier. */
interface TurnDraft {
  readonly sessionId: string;
  readonly role: TurnRole;
  readonly content: string;
}

const makeTurn = (entropy: EntropySourceService, draft: TurnDraft): Effect.Effect<Turn> =>
  Effect.map(makeId(entropy, idPrefix), id => ({ id, ...draft }));

export type { Turn, TurnDraft, TurnRole };
export { makeTurn };
