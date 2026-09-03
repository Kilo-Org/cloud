import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { type IdGenerator, layerUlid } from './id.js';
import { make } from './session.js';

const run = <A>(effect: Effect.Effect<A, never, IdGenerator>): A =>
  Effect.runSync(Effect.provide(effect, layerUlid));

it('makes an identifier of the form ses_{ulid}', () => {
  expect(run(make()).id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
});

it('orders two identifiers by the order they were made in', () => {
  const [first, second] = run(Effect.all([make(), make()]));
  expect(first.id < second.id).toBe(true);
});
