import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { asked, bench, options } from './resume-fixture.js';
import { cloneSession } from './resume.js';
import { openSession } from './run.js';

/**
 * Moving a conversation to another effort. A session freezes its effort with
 * its model, so a new effort is a copy, the same as a new model.
 */
it('opens the copy on the effort it was moved onto, and on none when it is cleared', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession({ ...options, effort: 'high' }), session =>
      Effect.as(asked(session, 'first'), session.id)
    )
  );

  const lowered = await desk.run(
    Effect.flatMap(cloneSession(opened.value, { effort: 'none' }), session =>
      Effect.as(asked(session, 'next'), session.id)
    )
  );
  const cleared = await desk.run(
    Effect.flatMap(cloneSession(lowered.value, { effort: 'default' }), session =>
      asked(session, 'last')
    )
  );

  expect(lowered.calls[0]?.effort).toBe('none');
  expect(cleared.calls[0]).not.toHaveProperty('effort');
});
