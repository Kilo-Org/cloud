import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  dispatcherCallContract,
  workOSDirectoryEvents,
  type RecordedDispatcherEvent,
} from '@kilocode/scim-contracts/fixtures';

import { harness, stub } from './harness';

/**
 * Producer half of the cross-deployment seam pin.
 *
 * Drives the real dispatcher, in workerd, over the recorded WorkOS event range
 * in `@kilocode/scim-contracts/fixtures` and asserts the ordered
 * `{ method, path, body }` it emits per event against the committed
 * `dispatcher-calls.json`. The consumer half replays that same file against the
 * app's real route handlers, so the two deployments are tested against one
 * artifact rather than against a fake of each other.
 *
 * This lives in the integration suite rather than `test/unit`, deliberately:
 * the recording has to go through the real `@workos-inc/node` deserializer and
 * the real Durable Object poll loop, and both need `cloudflare:test` and the
 * Workers runtime. A Node-side unit test could only call `applyEvent` with
 * hand-written camelCase payloads, which is the fake this exercise exists to
 * remove.
 *
 * The app origin is stubbed here, and only here: every route answers its
 * contract's 200, so each event emits the full call sequence it maps to rather
 * than stopping at the first refusal. What the real app does with those bodies
 * is the consumer test's assertion, not this one's.
 */

describe('dispatcher call contract', () => {
  it('emits the committed call sequence for every recorded event', async () => {
    const recorded: RecordedDispatcherEvent[] = [];

    // One poll per event, so every recorded call is attributable to the event
    // that produced it: the harness records calls in order but not their
    // event. The cursor advances across polls, which is also what the real
    // loop does between alarms.
    for (const event of workOSDirectoryEvents.events) {
      const io = harness({ pages: [[event]] });
      const result = await runInDurableObject(stub('contract'), instance => instance.poll());

      // Every event in the recorded range applies against a stub that answers
      // each route's contract, so a held or parked event here means the
      // dispatcher could not build a request at all — which would silently
      // record an empty call list.
      expect(result.heldFailure, `event ${event.id} was held`).toBeNull();
      expect(result.eventsParked, `event ${event.id} was parked`).toBe(0);

      recorded.push({
        eventId: event.id,
        eventType: event.event,
        calls: io.calls.map(call => ({
          method: call.method as 'PUT' | 'DELETE',
          path: call.path,
          body: call.body,
        })),
      });
    }

    try {
      expect(recorded).toEqual(dispatcherCallContract.events);
    } catch (error) {
      // The fixture is the seam, so a drift failure needs the new recording in
      // front of a human: updating it means checking the app accepts the new
      // shape first, which is the consumer test's job. See
      // `packages/scim-contracts/fixtures/README.md`.
      console.log(
        `[scim-contract] recorded dispatcher calls:\n${JSON.stringify(
          { generatedFrom: dispatcherCallContract.generatedFrom, events: recorded },
          null,
          2
        )}`
      );
      throw error;
    }
  });

  it('records the whole committed event range, in stream order', () => {
    // A fixture trimmed to the events that happen to pass would quietly shrink
    // the seam, so the two files are checked against each other as well.
    expect(dispatcherCallContract.events.map(e => e.eventId)).toEqual(
      workOSDirectoryEvents.events.map(e => e.id)
    );
    expect(workOSDirectoryEvents.events.at(0)?.id).toBe(workOSDirectoryEvents.rangeStart);
    expect(workOSDirectoryEvents.events.at(-1)?.id).toBe(workOSDirectoryEvents.rangeEnd);
  });
});
