import { Effect, Queue } from 'effect';
import { expect, it } from 'vitest';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { cancelQueued, enqueueMessage, makePending, wake } from './queue.js';

/**
 * The driver waits on one token per entry that joined the line. A round it gives
 * up on took nothing out of the line, but the token that pointed at it is spent,
 * so somebody has to ring the bell again — otherwise the entries wait on
 * whatever joins next, which for a caller's last message is forever.
 */

it('rings the bell again for a line that still holds something', async () => {
  const taken = await Effect.runPromise(
    Effect.gen(function* () {
      const pending = yield* makePending(seededEntropy(1));
      yield* enqueueMessage(pending, 'still waiting', {});
      /* The driver's take, spending the token the message brought with it. */
      yield* Queue.take(pending.arrived);
      yield* wake(pending);
      return yield* Queue.take(pending.arrived);
    })
  );

  expect(taken).toMatch(/^que_/);
});

it('rings no bell for a line that emptied while the driver waited', async () => {
  const woken = await Effect.runPromise(
    Effect.gen(function* () {
      const pending = yield* makePending(seededEntropy(1));
      const id = yield* enqueueMessage(pending, 'cancelled', {});
      yield* Queue.take(pending.arrived);
      yield* cancelQueued(pending, id);
      yield* wake(pending);
      return yield* Queue.size(pending.arrived);
    })
  );

  expect(woken).toBe(0);
});
