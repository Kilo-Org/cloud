import { Effect, TestClock, TestContext } from 'effect';
import { expect, it } from 'vitest';
import type { ToolCall } from '../../core/tool.js';
import { timeTool } from './time.js';

/**
 * The clock is pinned, so these assert the answer rather than assert around a
 * number that moves while they run. That is the whole reason the tool reads
 * `Clock` instead of calling `Date.now` itself.
 */

const call: ToolCall = { id: 'tc_1', name: 'time', arguments: '{}' };

/** A Thursday, deliberately: the weekday has to come from the date. */
const at = Date.parse('2026-09-03T17:04:09.512Z');

const asked = (tool: ReturnType<typeof timeTool>, one: ToolCall = call): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(TestClock.setTime(at), () => tool.run(one)),
      TestContext.TestContext
    )
  );

it('answers with the time the clock says, to the second', async () => {
  expect(await asked(timeTool())).toBe('2026-09-03T17:04:09Z (Thursday, UTC)');
});

it('gives the local time too when the harness named a zone', async () => {
  const said = await asked(timeTool({ zone: 'Europe/Amsterdam' }));

  /* Two hours ahead of UTC in September, which is the point of asking. */
  expect(said).toBe('2026-09-03T17:04:09Z (Thursday, UTC)\nEurope/Amsterdam: 2026-09-03 19:04:09');
});

it('says midnight as hour zero, not hour twenty-four', async () => {
  /* 22:30 UTC is 00:30 the next day in Amsterdam, which is the hour the two
     ways of asking for a 24-hour clock disagree about. */
  const midnight = Date.parse('2026-09-03T22:30:00.000Z');
  const said = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(TestClock.setTime(midnight), () =>
        timeTool({ zone: 'Europe/Amsterdam' }).run(call)
      ),
      TestContext.TestContext
    )
  );

  expect(said).toContain('Europe/Amsterdam: 2026-09-04 00:30:00');
});

it('answers a call that carries a field nobody reads', async () => {
  const noisy: ToolCall = { ...call, arguments: '{"zone":"Mars/Olympus"}' };

  /* A model that sends more than the schema asks for is answered rather than
     failed: nothing here reads the arguments, so there is nothing to be wrong. */
  expect(await asked(timeTool(), noisy)).toBe('2026-09-03T17:04:09Z (Thursday, UTC)');
});

it('is waited for, because the answer is the reason it was called', () => {
  const tool = timeTool();

  /* No `wait` of its own: the deadline decides, and a tool with no deadline
     advertises true. A model told to carry on without the time would have to
     ask again to use it. */
  expect(tool.wait).toBeUndefined();
  expect(tool.inlineFor).toBeUndefined();
});
