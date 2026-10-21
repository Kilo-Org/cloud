import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { SessionStore } from '../../core/storage.js';
import { textOf } from '../../core/turn.js';
import { layerNodeStore } from './node.js';

/**
 * A session and its subagent share one connection by design, and both write to
 * it while the other is mid-write. `driver.ts` says what SQLite does to two
 * transactions on one connection; this is the proof that neither loses its rows.
 */

const session = { id: 'ses_1', system: 'sys', model: 'claude-opus-5' };

const turnFor = (id: string) => ({
  sessionId: id,
  turns: [
    {
      id: `trn_${id}`,
      sessionId: id,
      role: 'user' as const,
      parts: [{ id: `prt_${id}`, kind: 'text' as const, body: `said by ${id}` }],
    },
  ],
  prompted: 0,
});

it('writes two sessions at once over one connection without losing either', async () => {
  const loaded = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(SessionStore, store =>
        Effect.gen(function* () {
          yield* store.create(session);
          yield* store.create({ ...session, id: 'ses_2' });
          yield* Effect.all([store.append(turnFor('ses_1')), store.append(turnFor('ses_2'))], {
            concurrency: 'unbounded',
          });
          return yield* Effect.all([store.load('ses_1'), store.load('ses_2')]);
        })
      ),
      layerNodeStore(new DatabaseSync(':memory:'))
    )
  );

  expect(loaded.map(turns => turns.map(textOf))).toEqual([['said by ses_1'], ['said by ses_2']]);
});
