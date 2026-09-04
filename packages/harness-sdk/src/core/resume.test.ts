import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { asked, bench, options, prompted } from './resume-fixture.js';
import { cloneSession, continueSession, SessionNotFoundError } from './resume.js';
import { openSession } from './run.js';
import { texts } from './session-fixture.js';
import { textIn } from './prompt.js';

it('carries the turns of an earlier run into the next one', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session =>
      Effect.as(asked(session, 'the first question'), session.id)
    )
  );

  const carried = await desk.run(
    Effect.flatMap(continueSession(opened.value), session => session.history)
  );

  expect(texts(carried.value)).toEqual(['user:the first question', 'assistant:an answer']);
});

it('reopens with the options it was stored with, not the ones a caller has now', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  const resumed = await desk.run(
    Effect.flatMap(continueSession(opened.value), session => asked(session, 'second'))
  );

  /* The system prompt is the front of the cached prefix. A resumed session that
     took a system prompt from its caller would drop the prefix on this call. */
  expect(resumed.calls[0]?.prompt.system[0]?.text).toBe(options.system);
  expect(resumed.calls[0]?.model).toBe(options.model);
});

it('asks the next question with the whole restored conversation in front of it', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  const resumed = await desk.run(
    Effect.flatMap(continueSession(opened.value), session => asked(session, 'second'))
  );

  expect(resumed.calls[0]?.prompt.messages.map(textIn)).toEqual(['first', 'an answer', 'second']);
});

it('refuses an identifier the store has never held', async () => {
  const desk = bench();

  const failed = await desk.run(Effect.flip(continueSession('ses_nothing')));

  expect(failed.value).toBeInstanceOf(SessionNotFoundError);
});

it('gives a clone its own identifier and its own turns', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  const cloned = await desk.run(
    Effect.flatMap(cloneSession(opened.value), session =>
      Effect.map(session.history, turns => ({ id: session.id, turns }))
    )
  );

  expect(cloned.value.id).not.toBe(opened.value);
  /* A copied turn identifier would collide on the primary key, and every
     identifier also carries the order the turns are read back in. */
  const ids = cloned.value.turns.map(turn => turn.id);
  expect(new Set(ids).size).toBe(2);
  expect(texts(cloned.value.turns)).toEqual(['user:first', 'assistant:an answer']);
});

it('sends a clone the same prompt bytes as the session it came from', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  /* The clone goes first. Continuing the original would append to it, and the
     two would then be compared at different lengths. */
  const clone = await desk.run(
    Effect.flatMap(cloneSession(opened.value), session => asked(session, 'next'))
  );
  const original = await desk.run(
    Effect.flatMap(continueSession(opened.value), session => asked(session, 'next'))
  );

  /* This is what makes a clone cheap: the prefix is identical, so the model
     reads it from its cache instead of building it again. */
  expect(prompted(clone.calls[0])).toBe(prompted(original.calls[0]));
});

it('leaves the original alone when the clone is asked something', async () => {
  const desk = bench();
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  await desk.run(
    Effect.flatMap(cloneSession(opened.value), session => asked(session, 'only on the branch'))
  );
  const original = await desk.run(
    Effect.flatMap(continueSession(opened.value), session => session.history)
  );

  expect(texts(original.value)).toEqual(['user:first', 'assistant:an answer']);
});

/**
 * A resumed session does not know how full it is.
 *
 * The compaction trigger is the provider's own count of the last request, and
 * nothing here estimates one. A session that is reopened has made no request
 * yet, so the count is zero and the first question goes out with the whole
 * stored conversation in front of it, however long that is. The answer to that
 * question reports a real count, and every question after it is measured.
 *
 * This is a known limit, not a decision that reads well. Closing it means
 * storing the count beside the session, which is a column and a migration.
 * Until then a caller that reopens a long conversation calls `session.compact`
 * itself, which is what that method is for.
 */
it('asks its first question after a resume without checking the window', async () => {
  const desk = bench({
    window: 1000,
    reply: { deltas: ['an answer'], usage: { inputTokens: 900, cacheReadTokens: 0 } },
  });
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  const resumed = await desk.run(
    Effect.flatMap(continueSession(opened.value), session => asked(session, 'second'))
  );

  /* One call, not two. The same session asked twice in one run compacts on the
     second question, because the first answer reported 900 of a 1000 window. */
  expect(resumed.calls).toHaveLength(1);
});

it('learns the count from the first answer, and compacts on the question after it', async () => {
  const desk = bench({
    window: 1000,
    reply: { deltas: ['an answer'], usage: { inputTokens: 900, cacheReadTokens: 0 } },
  });
  const opened = await desk.run(
    Effect.flatMap(openSession(options), session => Effect.as(asked(session, 'first'), session.id))
  );

  const resumed = await desk.run(
    Effect.flatMap(continueSession(opened.value), session =>
      Effect.zipRight(asked(session, 'second'), asked(session, 'third'))
    )
  );

  /* Three: the second question, the summary it triggers, and the third. So the
     gap is one question wide, and it closes itself. */
  expect(resumed.calls).toHaveLength(3);
});
