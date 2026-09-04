import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { ModelError, type ModelUsage } from '../../core/model.js';
import { recordingStore, runWith } from '../../core/session-fixture.js';
import { ToolRegistry } from '../../core/tool.js';
import { layerTableCatalog } from '../catalog/table.js';
import { layerSeededEntropy } from '../entropy/seeded.js';
import { fakeModel, type FakeReply } from '../model/fake.js';
import { layerAssembler } from '../prompt/default.js';
import {
  type SubagentContext,
  type SubagentOptions,
  type SubagentReport,
  subagentTool,
} from './subagent.js';

/**
 * A tool that is a session of its own.
 *
 * What is under test is what crosses between the two. One answer goes up to the
 * parent; the subagent's own steps stay in its own transcript, which is what
 * makes a subagent worth having. Nothing else crosses on its own: the counts go
 * to whoever asked for them, and a subagent that fails is a failed result and
 * not a failed session.
 */

const call = { id: 'tc_1', name: 'subagent', arguments: '{"task":"count the files"}' };

const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['subagent'],
};

/** A tool only the subagent has, so a step of its own is a step to look for. */
const look = Layer.succeed(ToolRegistry, {
  tools: [
    {
      definition: {
        name: 'look',
        description: 'Counts the files.',
        parameters: { type: 'object', properties: {} },
      },
      run: () => Effect.succeed('nine files'),
    },
  ],
});

/** The layers a subagent runs under, with a model of its own to script. */
const under = (replies: readonly FakeReply[]) => {
  const model = fakeModel(replies);
  return {
    model,
    layers: Layer.mergeAll(
      layerAssembler,
      layerTableCatalog({}, { apiKinds: ['messages'] }),
      layerSeededEntropy(2),
      model.layer,
      look
    ),
  };
};

const answered = (events: readonly { readonly kind: string }[]) =>
  events.filter(event => event.kind === 'toolResult');

/** The parent's registry, holding one subagent over the layers given. */
const offering = (layers: Layer.Layer<SubagentContext>, extra: Partial<SubagentOptions> = {}) =>
  Layer.succeed(ToolRegistry, {
    tools: [
      subagentTool({ system: 'You count things.', model: 'claude-haiku-4-5', ...extra }, layers),
    ],
  });

/**
 * One parent round in which the subagent takes two rounds of its own: it calls
 * its own tool, reads what the tool said, and only then answers.
 */
const twoRounds = () => {
  const reports: SubagentReport[] = [];
  const sub = under([
    { deltas: ['looking'], calls: [{ id: 'sc_1', name: 'look', arguments: '{}' }], stop: 'tools' },
    { deltas: ['there are nine files'] },
  ]);
  const store = recordingStore();
  const ran = runWith({
    options,
    store: store.layer,
    tools: offering(sub.layers, {
      tools: ['look'],
      onFinished: report => Effect.sync(() => void reports.push(report)),
    }),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['nine, it says'] }],
    use: session =>
      Effect.gen(function* () {
        const events = [...(yield* Stream.runCollect(session.ask('how many files?')))];
        return { id: session.id, events, history: yield* session.history };
      }),
  });
  return { reports, sub, store, ran };
};

const textIn = (turns: readonly { readonly parts: readonly { readonly body: string }[] }[]) =>
  turns.map(turn => turn.parts.map(part => part.body).join('')).join('|');

it('hands the parent one answer, and keeps the subagent’s steps to itself', async () => {
  const { sub, ran } = twoRounds();
  const { value } = await ran;

  /* One string reached the parent: what the subagent finally said. */
  expect(answered(value.events)).toMatchObject([
    { result: { callId: 'tc_1', body: 'there are nine files', failed: false } },
  ]);
  /* And nothing it did on the way is in the parent's transcript. */
  expect(textIn(value.history)).not.toContain('looking');
  expect(textIn(value.history)).toContain('there are nine files');
  expect(sub.model.calls).toHaveLength(2);
});

it('writes the subagent to the parent’s store, under a session of its own', async () => {
  const { reports, store, ran } = twoRounds();
  const { value } = await ran;

  /* A session reads the store from the context it runs in, and a tool runs in
     the parent's. So both wrote to one database — under two session
     identifiers, which is what a store keyed by session is for. */
  expect(store.seen.join('|')).toContain('assistant:looking');
  expect(reports[0]?.sessionId).not.toBe(value.id);
});

it('counts the subagent’s tokens against the subagent, and hands them over', async () => {
  const reports: SubagentReport[] = [];
  const sub = under([{ deltas: ['nine'], usage: { inputTokens: 40, outputTokens: 9 } }]);

  const { value } = await runWith({
    options,
    tools: offering(sub.layers, {
      onFinished: report => Effect.sync(() => void reports.push(report)),
    }),
    replies: [
      { deltas: [], calls: [call], stop: 'tools', usage: { inputTokens: 11, outputTokens: 2 } },
      { deltas: ['nine, it says'], usage: { inputTokens: 12, outputTokens: 3 } },
    ],
    use: session => Effect.zipRight(Stream.runDrain(session.ask('how many?')), session.usage),
  });

  const parent: ModelUsage = value;
  /* The parent paid for its own two calls and nothing else. */
  expect(parent.inputTokens).toBe(23);
  expect(parent.outputTokens).toBe(5);
  /* The subagent's counts are its own, and reach the caller that asked. */
  expect(reports).toMatchObject([{ said: 'nine', usage: { inputTokens: 40, outputTokens: 9 } }]);
  expect(reports[0]?.sessionId).not.toBe('');
});

it('hands the model a failed result when the subagent fails', async () => {
  const sub = under([
    { deltas: [], fail: new ModelError({ reason: 'transport', cause: 'no route' }) },
  ]);

  const { value } = await runWith({
    options,
    tools: offering(sub.layers),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['I will do it myself'] }],
    use: session => Stream.runCollect(session.ask('how many files?')),
  });

  const [result] = answered([...value]);
  expect(result).toMatchObject({ result: { callId: 'tc_1', failed: true } });
  /* The parent read what went wrong and carried on, which is the whole point of
     a failed result rather than a failed session. */
  expect(String(Reflect.get(result ?? {}, 'result'))).not.toBe('');
});

it('refuses a task it cannot read, without opening a session', async () => {
  const sub = under([{ deltas: ['never asked'] }]);

  const { value } = await runWith({
    options,
    tools: offering(sub.layers),
    replies: [
      { deltas: [], calls: [{ ...call, arguments: '{"job":"count"}' }], stop: 'tools' },
      { deltas: ['I will do it myself'] },
    ],
    use: session => Stream.runCollect(session.ask('how many files?')),
  });

  expect(answered([...value])).toMatchObject([{ result: { failed: true } }]);
  /* Nothing was asked of the subagent's model, so nothing was spent on it. */
  expect(sub.model.calls).toHaveLength(0);
});
