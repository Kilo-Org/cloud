import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { runWith } from './session-fixture.js';
import { type Tool, ToolRegistry } from './tool.js';

/**
 * A tool that refuses to overlap, across two sessions that share it.
 *
 * `concurrent: false` protects the thing the tool holds — the terminal the
 * asker owns, the one dialog, the file it rewrites — and that thing outlives
 * any one session. A permit made per session would lock nothing between two of
 * them, which is what a parent and its subagent are: two sessions, one registry,
 * one person to interrupt.
 */

const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['hold'],
};

const call = { id: 'tc_1', name: 'hold', arguments: '{}' };

/**
 * A tool that says when it starts and when it stops, and takes long enough in
 * between that an overlap is a certainty rather than a race.
 */
const holding = (seen: string[], concurrent?: boolean): Tool => ({
  definition: {
    name: 'hold',
    description: 'hold',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  ...(concurrent === undefined ? {} : { concurrent }),
  run: () =>
    Effect.sync(() => void seen.push('in'))
      .pipe(Effect.flatMap(() => Effect.sleep('50 millis')))
      .pipe(Effect.as('held'))
      .pipe(Effect.tap(() => Effect.sync(() => void seen.push('out')))),
});

/** One session, asking for the tool once and reading the answer. */
const asking = (tool: Tool) =>
  runWith({
    options,
    tools: Layer.succeed(ToolRegistry, { tools: [tool] }),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['done'] }],
    use: session => Stream.runCollect(session.ask('hold it')),
  });

/** Two sessions, at the same time, over one tool. */
const both = async (tool: Tool): Promise<void> => {
  await Promise.all([asking(tool), asking(tool)]);
};

it('keeps two sessions out of one tool that refuses to overlap', async () => {
  const seen: string[] = [];

  await both(holding(seen, false));

  /* One in and out before the next in. Interleaved would be in,in,out,out, and
     that is the shape a per-session permit produced. */
  expect(seen).toStrictEqual(['in', 'out', 'in', 'out']);
});

it('lets two sessions into a tool that allows overlap', async () => {
  const seen: string[] = [];

  await both(holding(seen));

  /* The default, and the reason the flag is worth having: a tool holding
     nothing runs both calls at once rather than paying the wall clock twice. */
  expect(seen).toStrictEqual(['in', 'in', 'out', 'out']);
});

it('lets two sessions into two tools that each refuse to overlap alone', async () => {
  const seen: string[] = [];

  /* Two tools built separately hold two different things. Serialising one
     against the other would be a wait bought for nothing. */
  await Promise.all([asking(holding(seen, false)), asking(holding(seen, false))]);

  expect(seen).toStrictEqual(['in', 'in', 'out', 'out']);
});
