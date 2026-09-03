import { Chunk, Effect } from 'effect';
import { expect, it } from 'vitest';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { assemble } from '../plugins/prompt/default.js';
import type { Prompt } from './prompt.js';
import { makeSession } from './session.js';
import { makeTurn } from './turn.js';

const entropy = seededEntropy(3);
const system = 'You are a harness.';

const turnsOf = (sessionId: string, count: number) =>
  Chunk.fromIterable(
    Array.from({ length: count }, (_, index) =>
      Effect.runSync(
        makeTurn(entropy, {
          sessionId,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `message number ${String(index)}`,
        })
      )
    )
  );

/**
 * The cache invariant, stated as one property: as a session grows, everything
 * the model has already seen must render to the same bytes it rendered last
 * time. A prompt that reorders, rewrites or re-marks an earlier turn drops the
 * whole prefix, and the only symptom in production is a bill.
 *
 * This is the one performance requirement the package fully controls, so it is
 * asserted as behavior rather than measured as a duration.
 */
const grow = (count: number): readonly Prompt[] => {
  const session = Effect.runSync(makeSession(entropy));
  const every = turnsOf(session.id, count);
  return Array.from({ length: count }, (_, index) =>
    assemble({ system, turns: Chunk.take(every, index + 1) })
  );
};

it('never changes a byte of what the model has already seen', () => {
  const prompts = grow(50);

  for (let index = 1; index < prompts.length; index += 1) {
    const earlier = prompts[index - 1];
    const later = prompts[index];
    if (earlier === undefined || later === undefined) {
      throw new Error('the growth series is incomplete');
    }

    /* Every message the earlier prompt did not end on must survive untouched,
       cache marks included. The last one is allowed to move, because the
       breakpoint moves with it. */
    const settled = earlier.messages.length - 1;
    expect(JSON.stringify(later.messages.slice(0, settled))).toBe(
      JSON.stringify(earlier.messages.slice(0, settled))
    );
    expect(JSON.stringify(later.system)).toBe(JSON.stringify(earlier.system));
  }
});

it('marks exactly one breakpoint in the system and one on the last message', () => {
  const session = Effect.runSync(makeSession(entropy));
  const prompt = assemble({ system, turns: turnsOf(session.id, 8) });

  expect(prompt.system.filter(block => block.cache)).toHaveLength(1);
  expect(prompt.messages.map(message => message.cache)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
});

it('moves the breakpoint forward by exactly one message per turn', () => {
  const session = Effect.runSync(makeSession(entropy));
  const marks = [4, 5, 6].map(count =>
    assemble({ system, turns: turnsOf(session.id, count) }).messages.findIndex(
      message => message.cache
    )
  );

  expect(marks).toEqual([3, 4, 5]);
});
