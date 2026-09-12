import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { makeSession } from './session.js';

const entropy = seededEntropy(1);

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

it('makes an identifier of the form ses_{ulid}', () => {
  expect(run(makeSession(entropy)).id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
});

it('orders two identifiers by the order they were made in', () => {
  const [first, second] = run(Effect.all([makeSession(entropy), makeSession(entropy)]));
  expect(first.id < second.id).toBe(true);
});
