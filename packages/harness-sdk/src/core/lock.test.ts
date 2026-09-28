import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { runWith } from './session-fixture.js';
import { type Tool, type ToolDefinition, ToolRegistry } from './tool.js';

/**
 * A session serialises nothing, and a tool that must not be re-entered says so
 * itself.
 *
 * The session used to own this, as a `concurrent: false` flag and a permit the
 * runner took before calling `run`. It was the wrong owner twice over. A permit
 * per session locked nothing between two sessions, which was a plain bug; and
 * the fix for that — one permit per tool object, kept by the core — had the core
 * inventing an identity for a thing it does not own, to protect a thing it
 * cannot see. What needs protecting is the terminal, the file, the person: all
 * the caller's, all supplied by the caller along with the tool that touches
 * them. So the caller holds the permit, in the tool, next to the thing.
 *
 * What that buys is the invariant these tests are for: **a session is
 * independent of every other in every way.** There is nothing left in the core
 * that two sessions share.
 */

const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['hold'],
};

const call = { id: 'tc_1', name: 'hold', arguments: '{}' };

const definition: ToolDefinition = {
  name: 'hold',
  description: 'hold',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/** Says when it starts and stops, and takes long enough that an overlap shows. */
const marking = (seen: string[]): Effect.Effect<string> =>
  Effect.sync(() => void seen.push('in'))
    .pipe(Effect.flatMap(() => Effect.sleep('50 millis')))
    .pipe(Effect.tap(() => Effect.sync(() => void seen.push('out'))))
    .pipe(Effect.as('held'));

/** A tool that lets anything overlap, which is every tool by default. */
const open = (seen: string[]): Tool => ({ definition, run: () => marking(seen) });

/** A tool that holds one thing, and holds a permit beside it. */
const guarded = (seen: string[]): Tool => {
  const permit = Effect.unsafeMakeSemaphore(1);
  return { definition, run: () => permit.withPermits(1)(marking(seen)) };
};

/** One session, asking for the tool once. */
const asking = (tool: Tool) =>
  runWith({
    options,
    tools: Layer.succeed(ToolRegistry, { tools: [tool] }),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['done'] }],
    use: session => Stream.runCollect(session.ask('hold it')),
  });

it('keeps two sessions out of a tool that holds its own permit', async () => {
  const seen: string[] = [];
  const tool = guarded(seen);

  await Promise.all([asking(tool), asking(tool)]);

  /* One in and out before the next in. This is a parent and its subagent over
     one terminal, and the tool is the only party that knew there was one. */
  expect(seen).toStrictEqual(['in', 'out', 'in', 'out']);
});

it('leaves two sessions alone when the tool holds nothing', async () => {
  const seen: string[] = [];
  const tool = open(seen);

  await Promise.all([asking(tool), asking(tool)]);

  expect(seen).toStrictEqual(['in', 'in', 'out', 'out']);
});

it('serialises two calls in one turn, from inside the tool', async () => {
  const seen: string[] = [];
  const tool = guarded(seen);

  await runWith({
    options,
    tools: Layer.succeed(ToolRegistry, { tools: [tool] }),
    replies: [
      { deltas: [], calls: [call, { ...call, id: 'tc_2' }], stop: 'tools' },
      { deltas: ['done'] },
    ],
    use: session => Stream.runCollect(session.ask('hold it twice')),
  });

  /* The runner starts both at once, because the model asks for several when
     they are independent. The tool is what makes these two not independent. */
  expect(seen).toStrictEqual(['in', 'out', 'in', 'out']);
});

it('keeps two tools over two things out of each other’s way', async () => {
  const seen: string[] = [];

  /* Two permits, because two tools built separately hold two different things.
     Serialising one against the other would be a wait bought for nothing. */
  await Promise.all([asking(guarded(seen)), asking(guarded(seen))]);

  expect(seen).toStrictEqual(['in', 'in', 'out', 'out']);
});
