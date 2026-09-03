import { Chunk, Effect } from 'effect';
import { expect, it } from 'vitest';
import { type IdGenerator, layerUlid } from './id.js';
import { appendTurn, makeSession } from './session.js';
import { makeTurn } from './turn.js';

const run = <A>(effect: Effect.Effect<A, never, IdGenerator>): A =>
  Effect.runSync(Effect.provide(effect, layerUlid));

it('makes a turn that carries its fields and a trn_{ulid} identifier', () => {
  const turn = run(makeTurn('ses_1', 'user', 'hello'));
  expect(turn).toMatchObject({ sessionId: 'ses_1', role: 'user', content: 'hello' });
  expect(turn.id).toMatch(/^trn_[0-9A-HJKMNP-TV-Z]{26}$/);
});

it('appends turns in order and leaves the earlier session untouched', () => {
  const [session, first, second] = run(
    Effect.all([makeSession(), makeTurn('ses_1', 'user', 'a'), makeTurn('ses_1', 'assistant', 'b')])
  );
  const appended = appendTurn(appendTurn(session, first), second);

  expect(Chunk.toReadonlyArray(appended.turns).map(turn => turn.content)).toEqual(['a', 'b']);
  expect(Chunk.isEmpty(session.turns)).toBe(true);
});
