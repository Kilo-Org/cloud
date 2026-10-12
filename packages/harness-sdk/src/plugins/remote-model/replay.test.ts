import { Effect, Layer, Schedule, Stream } from 'effect';
import { expect, it } from 'vitest';
import { RetryPolicy } from '../../core/retry.js';
import { openSession } from '../../core/run.js';
import { ToolRegistry } from '../../core/tool.js';
import { layerTableCatalog } from '../catalog/table.js';
import { layerSeededEntropy } from '../entropy/seeded.js';
import { fakeFetch, sampleRequest, sse } from '../gateway/fake.js';
import { completionsWire } from '../gateway/wire/completions.js';
import { layerAssembler } from '../prompt/default.js';
import { layerRemoteModel } from './index.js';

const responses = [
  {
    ok: true,
    status: 200,
    body: '',
    chunks: sse(
      { choices: [{ delta: { reasoning_content: 'Look up ' } }] },
      {
        choices: [{ delta: { reasoning_content: 'the weather.', content: 'Checking.' } }],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-weather', function: { name: 'weather', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }
    ),
  },
  {
    ok: true,
    status: 200,
    body: '',
    chunks: sse({
      choices: [
        {
          delta: { reasoning_content: 'Use the result.', content: 'Sunny.' },
          finish_reason: 'stop',
        },
      ],
    }),
  },
  {
    ok: true,
    status: 200,
    body: '',
    chunks: sse({ choices: [{ delta: { content: 'You are welcome.' }, finish_reason: 'stop' }] }),
  },
];

const toolTurn = {
  role: 'assistant',
  content: 'Checking.',
  reasoning_content: 'Look up the weather.',
  tool_calls: [
    { id: 'call-weather', type: 'function', function: { name: 'weather', arguments: '{}' } },
  ],
};
const replay = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'Weather?' },
  toolTurn,
  { role: 'tool', tool_call_id: 'call-weather', content: 'Sunny' },
];

it('replays streamed reasoning through a real tool turn and the next question', async () => {
  const { fetch, calls } = fakeFetch(responses);
  let toolRuns = 0;
  const layers = Layer.mergeAll(
    layerAssembler,
    layerSeededEntropy(1),
    layerTableCatalog({}, { apiKinds: ['chat_completions'] }),
    layerRemoteModel({
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      fetch,
      headers: () => Effect.succeed({}),
    }).pipe(Layer.provide(Layer.succeed(RetryPolicy, { schedule: Schedule.recurs(0) }))),
    Layer.succeed(ToolRegistry, {
      tools: [
        {
          definition: {
            name: 'weather',
            description: 'Weather',
            parameters: { type: 'object', properties: {} },
          },
          run: () =>
            Effect.sync(() => {
              toolRuns += 1;
              return 'Sunny';
            }),
        },
      ],
    })
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        openSession({ system: 'sys', model: 'upstream', maxTokens: 1024, tools: ['weather'] }),
        session =>
          Effect.zipRight(
            Stream.runDrain(session.ask('Weather?')),
            Stream.runDrain(session.ask('Thanks'))
          )
      )
    ).pipe(Effect.provide(layers))
  );
  expect(toolRuns).toBe(1);
  expect(JSON.parse(calls[1]?.request.body ?? '')).toHaveProperty('messages', replay);
  expect(JSON.parse(calls[2]?.request.body ?? '')).toHaveProperty('messages', [
    ...replay,
    { role: 'assistant', content: 'Sunny.', reasoning_content: 'Use the result.' },
    { role: 'user', content: 'Thanks' },
  ]);
});

it('keeps gateway completion limits and assistant serialization unchanged', () => {
  const request = sampleRequest();
  const body = completionsWire.toBody({
    ...request,
    prompt: {
      ...request.prompt,
      messages: [
        {
          role: 'assistant',
          cache: false,
          parts: [
            { kind: 'reasoning', text: 'Supplied reasoning' },
            { kind: 'text', text: 'Answer' },
          ],
        },
      ],
    },
  });
  expect(body).toHaveProperty('max_tokens', 1024);
  expect(body).toHaveProperty('messages', [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
  ]);
  expect(body).not.toHaveProperty('max_completion_tokens');
});
