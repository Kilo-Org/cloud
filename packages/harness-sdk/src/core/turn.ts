import { Effect } from 'effect';
import { z } from 'zod';
import { IdGenerator } from './id.js';

/**
 * One turn of a conversation. The shape is one SQLite row: flat, four columns,
 * no nesting and no join. The identifier is a monotonic ULID, so it is both the
 * primary key and the sort order; a separate timestamp column would repeat what
 * the identifier already holds.
 */
const TurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

type Turn = z.infer<typeof TurnSchema>;
type TurnRole = Turn['role'];

const idPrefix = 'trn';

const makeTurn = (
  sessionId: string,
  role: TurnRole,
  content: string
): Effect.Effect<Turn, never, IdGenerator> =>
  IdGenerator.pipe(
    Effect.flatMap(generator => generator.generate(idPrefix)),
    Effect.map(id => ({ id, sessionId, role, content }))
  );

export type { Turn, TurnRole };
export { makeTurn, TurnSchema };
