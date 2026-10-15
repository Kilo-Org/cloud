import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { ModelError, zeroUsage } from './model.js';
import { catalogWindowed, runWith } from './session-fixture.js';
import { ToolRegistry } from './tool.js';

const requested = 'kilo-auto/balanced';
const usage = (inputTokens: number, outputTokens: number, cost: number) => ({
  ...zeroUsage,
  inputTokens,
  outputTokens,
  cost,
});

it('attributes every tool round to its served model while continuing to request Auto', async () => {
  const first = usage(10, 2, 0.01);
  const second = usage(20, 3, 0.02);
  const { value, calls } = await runWith({
    options: { system: 'sys', model: requested, maxTokens: 1024, tools: ['weather'] },
    tools: Layer.succeed(ToolRegistry, {
      tools: [
        {
          definition: {
            name: 'weather',
            description: 'weather',
            parameters: { type: 'object', properties: {} },
          },
          run: () => Effect.succeed('sunny'),
        },
      ],
    }),
    replies: [
      {
        model: 'vendor/first',
        deltas: [],
        calls: [{ id: 'tc_1', name: 'weather', arguments: '{}' }],
        stop: 'tools',
        usage: first,
      },
      { model: 'vendor/second', deltas: ['sunny'], usage: second },
    ],
    use: session =>
      Effect.gen(function* () {
        const events = yield* Stream.runCollect(session.ask('weather?'));
        return {
          events: [...events],
          total: yield* session.usage,
          models: yield* session.usageByModel,
        };
      }),
  });

  expect(calls.map(call => call.model)).toEqual([requested, requested]);
  expect(value.events.filter(event => event.kind === 'done').map(event => event.model)).toEqual([
    'vendor/first',
    'vendor/second',
  ]);
  expect(value.models).toEqual(
    new Map([
      ['vendor/first', first],
      ['vendor/second', second],
    ])
  );
  expect(value.total).toEqual(usage(30, 5, 0.03));
});

it('attributes hidden compaction calls independently and falls back only when no model was reported', async () => {
  const first = usage(900, 5, 0.09);
  const summary = usage(40, 20, 0.04);
  const last = usage(7, 3, 0.007);
  const { value, calls } = await runWith({
    options: { system: 'sys', model: requested, maxTokens: 1024 },
    catalog: catalogWindowed(1000),
    replies: [
      { model: 'vendor/first', deltas: ['answer'], usage: first },
      { model: 'vendor/summary', deltas: ['notes'], usage: summary },
      { deltas: ['next'], usage: last },
    ],
    use: session =>
      Effect.gen(function* () {
        yield* Stream.runDrain(session.ask('one'));
        yield* Stream.runDrain(session.ask('two'));
        return { models: yield* session.usageByModel, total: yield* session.usage };
      }),
  });

  expect(calls.map(call => call.model)).toEqual([requested, requested, requested]);
  expect(value.models).toEqual(
    new Map([
      ['vendor/first', first],
      ['vendor/summary', summary],
      [requested, last],
    ])
  );
  expect(value.total.inputTokens).toBe(947);
  expect(value.total.outputTokens).toBe(28);
  expect(value.total.cost).toBeCloseTo(0.137);
});

it('keeps a billed summary in model totals when the following answer fails', async () => {
  const first = usage(900, 5, 0.09);
  const summary = usage(40, 20, 0.04);
  const { value } = await runWith({
    options: { system: 'sys', model: requested, maxTokens: 1024 },
    catalog: catalogWindowed(1000),
    replies: [
      { model: 'vendor/answer', deltas: ['answer'], usage: first },
      { model: 'vendor/summary', deltas: ['notes'], usage: summary },
      { deltas: [], fail: new ModelError({ reason: 'transport', cause: 'offline' }) },
    ],
    use: session =>
      Effect.gen(function* () {
        yield* Stream.runDrain(session.ask('one'));
        yield* Effect.either(Stream.runDrain(session.ask('two')));
        return yield* session.usageByModel;
      }),
  });

  expect(value).toEqual(
    new Map([
      ['vendor/answer', first],
      ['vendor/summary', summary],
    ])
  );
});
