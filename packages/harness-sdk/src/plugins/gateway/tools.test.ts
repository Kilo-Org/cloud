import { Effect, Stream } from 'effect';
import { createAssert } from 'typia';
import { expect, it } from 'vitest';
import type { ApiKind } from '../../core/catalog.js';
import { ModelClient, type ModelEvent, type ModelRequest } from '../../core/model.js';
import type { ToolDefinition } from '../../core/tool.js';
import { fakeFetch, type Reply, sampleRequest, sse } from './fake.js';
import { testGateway } from './test-gateway.js';

/**
 * A tool call arrives in pieces on every shape, and no shape sends the same
 * pieces as another. What is proved here is that all three arrive above the
 * transport as one `toolCall` carrying the whole of the arguments, so nothing
 * else in the package has to know how a shape spells one.
 */

const weather: ToolDefinition = {
  name: 'weather',
  description: 'The weather somewhere.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const withTools = (): ModelRequest => ({ ...sampleRequest(), tools: [weather] });

/** What went on the wire, so a test can read one field of it by name. */
const asBody = createAssert<Record<string, unknown>>();

const collect = async (kind: ApiKind, chunks: readonly string[]) => {
  const reply: Reply = { ok: true, status: 200, body: '', chunks };
  const { calls, fetch } = fakeFetch([reply]);
  const events = await ModelClient.pipe(
    Effect.map(client => client.stream(withTools())),
    Stream.unwrap,
    Stream.runCollect,
    Effect.map(chunk => [...chunk]),
    Effect.provide(testGateway({ fetch, kinds: [kind] })),
    Effect.runPromise
  );
  return { sent: asBody(JSON.parse(calls[0]?.request.body ?? '{}')), events };
};

const callsIn = (events: readonly ModelEvent[]) =>
  events.filter(event => event.kind === 'toolCall').map(event => event.call);

const stopOf = (events: readonly ModelEvent[]) =>
  events.find(event => event.kind === 'done')?.stop;

it('collects a call the messages shape streams as blocks, and says the model wants it', async () => {
  const { sent, events } = await collect(
    'messages',
    sse(
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tc_1', name: 'weather' } },
      { type: 'content_block_delta', delta: { partial_json: '{"city"' } },
      { type: 'content_block_delta', delta: { partial_json: ':"Oslo"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }
    )
  );

  expect(callsIn(events)).toEqual([{ id: 'tc_1', name: 'weather', arguments: '{"city":"Oslo"}' }]);
  expect(stopOf(events)).toBe('tools');
  expect(sent['tools']).toEqual([
    {
      name: 'weather',
      description: 'The weather somewhere.',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ]);
});

it('collects a call the responses shape streams as items', async () => {
  const { sent, events } = await collect(
    'responses',
    sse(
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'tc_2', name: 'weather' },
      },
      { type: 'response.function_call_arguments.delta', delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', delta: '"Oslo"}' },
      { type: 'response.output_item.done', item: { type: 'function_call' } },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }
    )
  );

  expect(callsIn(events)).toEqual([{ id: 'tc_2', name: 'weather', arguments: '{"city":"Oslo"}' }]);
  /* This shape reports a finished response whether or not the model asked for
     anything, so the reason comes from the call having been made. */
  expect(stopOf(events)).toBe('tools');
  expect(sent['tools']).toMatchObject([{ type: 'function', name: 'weather', strict: false }]);
});

it('collects two calls the completions shape never closes, and closes the last itself', async () => {
  const { sent, events } = await collect(
    'chat_completions',
    sse(
      {
        choices: [
          { delta: { tool_calls: [{ id: 'tc_3', function: { name: 'weather', arguments: '' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"city":"Oslo"}' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ id: 'tc_4', function: { name: 'weather', arguments: '' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"city":"Rome"}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] }
    )
  );

  /* The first call is closed by the frame that opens the second, and the second
     by the end of the stream. This shape sends nothing that closes either. */
  expect(callsIn(events)).toEqual([
    { id: 'tc_3', name: 'weather', arguments: '{"city":"Oslo"}' },
    { id: 'tc_4', name: 'weather', arguments: '{"city":"Rome"}' },
  ]);
  expect(stopOf(events)).toBe('tools');
  expect(sent['tools']).toMatchObject([{ type: 'function', function: { name: 'weather' } }]);
});

it('leaves the tools out of a request that offers none', async () => {
  const reply: Reply = { ok: true, status: 200, body: '', chunks: sse({}) };
  const { calls, fetch } = fakeFetch([reply]);
  await ModelClient.pipe(
    Effect.map(client => client.stream(sampleRequest())),
    Stream.unwrap,
    Stream.runDrain,
    Effect.provide(testGateway({ fetch, kinds: ['messages'] })),
    Effect.runPromise
  );

  /* Not an empty list: an empty list would sit in the prefix of every session
     that has no tools, and some shapes refuse one outright. */
  expect(JSON.parse(calls[0]?.request.body ?? '{}')).not.toHaveProperty('tools');
});

it('keeps a truncated answer truncated, whatever it half asked for', async () => {
  const { events } = await collect(
    'messages',
    sse(
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tc_5', name: 'weather' } },
      { type: 'content_block_delta', delta: { partial_json: '{"cit' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4 } }
    )
  );

  /* The call is reported, because the model did make it and the transcript must
     hold it. The reason is not upgraded, so nothing runs half a call. */
  expect(callsIn(events)).toEqual([{ id: 'tc_5', name: 'weather', arguments: '{"cit' }]);
  expect(stopOf(events)).toBe('maxTokens');
});
