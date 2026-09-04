import { Chunk, Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { ModelError } from './model.js';
import { textIn } from './prompt.js';
import { catalogWindowed, options, recordingStore, runWith, texts } from './session-fixture.js';

/**
 * A session grows until the model refuses the request. Compaction replaces the
 * conversation with a summary of itself and replays nothing before it.
 *
 * The window is tiny in these tests and the usage is scripted, so the trigger
 * fires on the call the test intends and not on a token count that drifts.
 */

const window = 1000;

/** A call that fills the window, so the next question compacts first. */
const full = { deltas: ['answered'], usage: { inputTokens: 900, cacheReadTokens: 0 } };
/** A call that does not. */
const roomy = { deltas: ['answered'], usage: { inputTokens: 10, cacheReadTokens: 0 } };

const askTwice = runWith({
  replies: [full, { deltas: ['the notes'] }, { deltas: ['after'] }],
  catalog: catalogWindowed(window),
  use: session =>
    Effect.zipRight(
      Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
      session.history
    ),
});

it('summarises the conversation once it fills the window', async () => {
  const { value, calls } = await askTwice;

  /* The summariser is a call of its own, between the two questions, and it
     carries the transcript plus the instruction. */
  expect(calls).toHaveLength(3);
  expect(calls[1]?.prompt.messages.map(textIn).at(-1)).toContain('Summarise the conversation');
  expect(calls[1]?.stream).toBeFalsy();

  expect(texts(value)).toEqual([
    'user:one',
    'assistant:answered',
    'user:',
    'user:two',
    'assistant:after',
  ]);
});

it('asks the next question with the summary and nothing before it', async () => {
  const { calls } = await askTwice;

  /* The whole point: the turns before the summary are gone from the prompt.
     Keeping the recent ones verbatim is the shape that fails, because a
     thinking block is signed against the history that stood when it was made. */
  const asked = calls[2]?.prompt.messages.map(textIn);
  expect(asked).toEqual(['Summary of the conversation so far:\n\nthe notes', 'two']);
});

it('leaves a session that still fits alone', async () => {
  const { calls } = await runWith({
    replies: [roomy, { deltas: ['after'] }],
    catalog: catalogWindowed(window),
    use: session =>
      Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
  });

  /* Two questions, two calls. A summariser that ran here would cost a request
     and throw the cache away for nothing. */
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt.messages.map(textIn)).toEqual(['one', 'answered', 'two']);
});

it('never compacts when the catalog names no window', async () => {
  /* Guessing a window would either cut a conversation that fit, or fail to
     save one that did not. Saying nothing is the honest answer. */
  const { calls } = await runWith({
    replies: [full, { deltas: ['after'] }],
    use: session =>
      Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
  });

  expect(calls).toHaveLength(2);
});

it('counts what the cache read towards the window', async () => {
  /* A cached prefix still fills the window. Counting only the uncached tokens
     would let a long session run until the provider refused it. */
  const { calls } = await runWith({
    replies: [
      { deltas: ['answered'], usage: { inputTokens: 3, cacheReadTokens: 900 } },
      { deltas: ['the notes'] },
      { deltas: ['after'] },
    ],
    catalog: catalogWindowed(window),
    use: session =>
      Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
  });

  expect(calls).toHaveLength(3);
});

it('obeys a caller who sets the share', async () => {
  const { calls } = await runWith({
    replies: [roomy, { deltas: ['the notes'] }, { deltas: ['after'] }],
    catalog: catalogWindowed(window),
    options: { ...options, compactAt: 0.001 },
    use: session =>
      Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
  });

  expect(calls).toHaveLength(3);
});

it('compacts when the caller says so, whatever the window says', async () => {
  const { value, calls } = await runWith({
    replies: [roomy, { deltas: ['the notes'] }, { deltas: ['after'] }],
    catalog: catalogWindowed(window),
    use: session =>
      Effect.zipRight(
        Effect.zipRight(
          Effect.zipRight(Stream.runDrain(session.ask('one')), session.compact),
          Stream.runDrain(session.ask('two'))
        ),
        session.history
      ),
  });

  expect(calls).toHaveLength(3);
  expect(calls[2]?.prompt.messages.map(textIn)).toEqual([
    'Summary of the conversation so far:\n\nthe notes',
    'two',
  ]);
  /* The earlier turns are still the record of what happened. They are simply
     not what the model is asked with. */
  expect(Chunk.size(value)).toBe(5);
});

it('writes the summary to the store, so a continued session starts there too', async () => {
  const store = recordingStore();
  await runWith({
    replies: [full, { deltas: ['the notes'] }, { deltas: ['after'] }],
    catalog: catalogWindowed(window),
    store: store.layer,
    use: session =>
      Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
  });

  expect(store.seen).toEqual([
    'user:one',
    'assistant:answered',
    'user:',
    'user:two',
    'assistant:after',
    'flush',
  ]);
});

it('stops charging the old prompt size against the new one', async () => {
  /* After a compaction the request is small again, so a second compaction
     must not fire on the size the call before it reported. */
  const { calls } = await runWith({
    replies: [full, { deltas: ['the notes'] }, roomy, { deltas: ['after'] }],
    catalog: catalogWindowed(window),
    use: session =>
      Effect.zipRight(
        Effect.zipRight(Stream.runDrain(session.ask('one')), Stream.runDrain(session.ask('two'))),
        Stream.runDrain(session.ask('three'))
      ),
  });

  /* Three questions and one summariser. A second summariser would mean the
     session compacted on a number that no longer described it. */
  expect(calls).toHaveLength(4);
});

it('leaves the session alone when the summary call fails, and tries again', async () => {
  /* A summariser that cannot answer must not take the conversation with it.
     The question fails, the turns stand as they were, and the next question
     tries to compact again — the session is still too full not to. */
  const { value, calls } = await runWith({
    replies: [
      full,
      { deltas: [], fail: new ModelError({ reason: 'transport', cause: 'the socket died' }) },
      { deltas: ['the notes'] },
      { deltas: ['after'] },
    ],
    catalog: catalogWindowed(window),
    use: session =>
      Effect.zipRight(
        Effect.zipRight(
          Stream.runDrain(session.ask('one')),
          Effect.either(Stream.runDrain(session.ask('two')))
        ),
        Effect.zipRight(Stream.runDrain(session.ask('three')), session.history)
      ),
  });

  /* Four calls: the question, the summary that failed, the summary that did
     not, and the question that followed it. */
  expect(calls).toHaveLength(4);
  expect(texts(value)).toEqual([
    'user:one',
    'assistant:answered',
    'user:',
    'user:three',
    'assistant:after',
  ]);
});
