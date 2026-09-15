import { Duration, Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ModelEvent, ModelRequest } from './model.js';
import { runWith } from './session-fixture.js';
import { type Tool, ToolRegistry } from './tool.js';

/**
 * The model saying, per call, whether it wants to wait.
 *
 * Every tool names a default, because a tool that always outlives a request
 * knows that about itself. The model knows something the tool cannot: whether
 * this call is the one it is stuck on. So it answers `wait` on the call, and its
 * answer wins in both directions — it can give up on a call the tool expected it
 * to wait for, and wait for one the tool expected it to abandon.
 *
 * Waiting costs nothing at the provider. Tools run between requests, never
 * during one, so what a waiting model spends is the caller's own stream, and the
 * caller can cut that short whenever it likes with `session.background`.
 */

/* Long enough that nothing here reaches it. Every decision in this file is the
   model's, never the clock's. */
const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['look'],
  inlineFor: Duration.minutes(5),
};

const asking = (wait?: boolean) => ({
  id: 'tc_1',
  name: 'look',
  arguments: JSON.stringify(wait === undefined ? { path: 'x' } : { path: 'x', wait }),
});

/** What the tool says about waiting, in the two ways a tool can say it. */
interface Says {
  readonly inlineFor?: Duration.DurationInput;
  readonly wait?: boolean;
}

/** A tool that answers at once, so anything unanswered is a decision, not a race. */
const tool = (says: Says = {}, seen?: string[]): Layer.Layer<ToolRegistry> =>
  Layer.succeed(ToolRegistry, {
    tools: [
      {
        definition: {
          name: 'look',
          description: 'look',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
        ...says,
        run: (call): Effect.Effect<string> =>
          Effect.sync(() => {
            seen?.push(call.arguments);
            return 'nine';
          }),
      } satisfies Tool,
    ],
  });

/** What the model was told about the call, which is the whole question here. */
const bodyOf = (events: Iterable<ModelEvent>): string => {
  const found = [...events].find(event => event.kind === 'toolResult');
  return found === undefined ? '' : found.result.body;
};

/** What the model was told about waiting for this tool, as the schema says it. */
const shown = (held: { readonly calls: readonly ModelRequest[] }): unknown =>
  held.calls[0]?.tools?.[0]?.parameters.properties?.['wait'];

const answered = (tools: Layer.Layer<ToolRegistry>, wait?: boolean) =>
  runWith({
    options,
    tools,
    replies: [{ deltas: [], calls: [asking(wait)], stop: 'tools' }, { deltas: ['nine files'] }],
    use: session => Stream.runCollect(session.ask('how many files')),
  });

it('gives up on a call the tool expected it to wait for', async () => {
  /* No deadline of its own, so the session's five minutes would apply. */
  const { value } = await answered(tool(), false);

  expect(bodyOf(value)).toContain('still running');
});

it('waits for a call the tool expected it to abandon', async () => {
  const { value } = await answered(tool({ inlineFor: Duration.zero }), true);

  expect(bodyOf(value)).toBe('nine');
});

it('leaves the tool to decide when the model does not answer', async () => {
  const { value } = await answered(tool({ inlineFor: Duration.zero }));

  expect(bodyOf(value)).toContain('still running');
});

it('offers the field to the model and keeps it away from the tool', async () => {
  const seen: string[] = [];
  const { calls } = await answered(tool({ inlineFor: Duration.zero }, seen), true);

  expect(calls[0]?.tools?.[0]?.parameters.properties).toMatchObject({
    path: { type: 'string' },
    wait: { type: 'boolean' },
  });
  /* The tool is handed its own arguments and nothing else. A tool that
     validates them strictly would refuse a key its author never wrote. */
  expect(seen).toEqual(['{"path":"x"}']);
});

it('leaves arguments that are not an object for the tool to complain about', async () => {
  const seen: string[] = [];
  const { value } = await runWith({
    options,
    tools: tool({ inlineFor: Duration.zero }, seen),
    replies: [
      { deltas: [], calls: [{ id: 'tc_1', name: 'look', arguments: 'not json' }], stop: 'tools' },
      { deltas: ['nine files'] },
    ],
    use: session => Stream.runCollect(session.ask('how many files')),
  });

  /* Untouched: a runner that rewrote it would change the words of the
     complaint the tool is about to make. */
  expect(seen).toEqual(['not json']);
  expect(bodyOf(value)).toContain('still running');
});

it('survives arguments that parse to nothing at all', async () => {
  const seen: string[] = [];
  const { value } = await runWith({
    options,
    tools: tool({ inlineFor: Duration.zero }, seen),
    replies: [
      { deltas: [], calls: [{ id: 'tc_1', name: 'look', arguments: 'null' }], stop: 'tools' },
      { deltas: ['nine files'] },
    ],
    use: session => Stream.runCollect(session.ask('how many files')),
  });

  /* `null` parses, and taking a field off it throws. The session would die of a
     defect on a call the model was entitled to make. */
  expect(seen).toEqual(['null']);
  expect(bodyOf(value)).toContain('still running');
});

it('takes the tool at its word when the model says nothing', async () => {
  const { value } = await answered(tool({ wait: false }));

  /* The tool named no deadline, so the session's five minutes would hold the
     model here. `wait: false` is the tool saying nobody waits for this one. */
  expect(bodyOf(value)).toContain('still running');
});

it('lets the model wait for a tool that says nobody does', async () => {
  const { value } = await answered(tool({ wait: false }), true);

  expect(bodyOf(value)).toBe('nine');
});

it('tells the model what each tool expects, in the schema', async () => {
  const waits = await answered(tool({ wait: true }));
  const goes = await answered(tool({ wait: false }));
  const zero = await answered(tool({ inlineFor: Duration.zero }));
  const plain = await answered(tool());

  /* A tool that said so, either way. And one that said nothing: the deadline
     answers for it, because a tool nobody waits any time for is a tool nobody
     waits for. */
  expect(shown(waits)).toMatchObject({ default: true });
  expect(shown(goes)).toMatchObject({ default: false });
  expect(shown(zero)).toMatchObject({ default: false });
  expect(shown(plain)).toMatchObject({ default: true });
});
