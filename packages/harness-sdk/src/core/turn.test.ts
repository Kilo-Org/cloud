import { Chunk, Effect } from 'effect';
import { expect, it } from 'vitest';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { appendTurn, makeSession } from './session.js';
import { makeTurn, textOf } from './turn.js';

const entropy = seededEntropy(1);

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

it('makes a turn that carries its fields and a trn_{ulid} identifier', () => {
  const turn = run(
    makeTurn(entropy, {
      sessionId: 'ses_1',
      role: 'user',
      parts: [{ kind: 'text', body: 'hello' }],
    })
  );
  expect(turn).toMatchObject({ sessionId: 'ses_1', role: 'user' });
  expect(textOf(turn)).toBe('hello');
  expect(turn.id).toMatch(/^trn_[0-9A-HJKMNP-TV-Z]{26}$/);
});

it('appends turns in order and leaves the earlier session untouched', () => {
  const [session, first, second] = run(
    Effect.all([
      makeSession(entropy),
      makeTurn(entropy, { sessionId: 'ses_1', role: 'user', parts: [{ kind: 'text', body: 'a' }] }),
      makeTurn(entropy, {
        sessionId: 'ses_1',
        role: 'assistant',
        parts: [{ kind: 'text', body: 'b' }],
      }),
    ])
  );
  const appended = appendTurn(appendTurn(session, first), second);

  expect(Chunk.toReadonlyArray(appended.turns).map(textOf)).toEqual(['a', 'b']);
  expect(Chunk.isEmpty(session.turns)).toBe(true);
});
