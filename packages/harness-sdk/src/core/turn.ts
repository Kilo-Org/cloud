import { Effect } from 'effect';
import { createIs } from 'typia';
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

/**
 * Rows read back from a storage plugin are an edge: the package did not write
 * them this run, and no storage engine promises the shape it returns.
 */
const isTurn = createIs<Turn>();

const idPrefix = 'trn';

const makeTurn = (sessionId: string, role: TurnRole, content: string): Effect.Effect<Turn> =>
  Effect.map(makeId(idPrefix), id => ({ id, sessionId, role, content }));

export type { Turn, TurnRole };
export { isTurn, makeTurn };
