import { Duration, Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ModelEvent, ModelRequest } from './model.js';
import { recordingStore, runWith, texts } from './session-fixture.js';
import { type Tool, type ToolCall, ToolFailure, ToolRegistry } from './tool.js';

/**
 * What a question does when the model asks for a tool.
 *
 * The rule the whole loop exists to keep is that a call and its result are one
 * unit. The model asks, the tool answers, the model is asked again, and only
 * when it stops asking does any of it reach the store. Every shape refuses a
 * call whose result is missing, so a store that held half a round would hold a
 * session nobody could continue.
 */

const call = (id: string, name: string, args = '{}'): ToolCall => ({ id, name, arguments: args });

const tool = (
  name: string,
  run: Tool['run'],
  concurrent?: boolean
): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  ...(concurrent === undefined ? {} : { concurrent }),
  run,
});

const registry = (...tools: readonly Tool[]) => Layer.succeed(ToolRegistry, { tools });

const saying = (name: string, body: string) => tool(name, () => Effect.succeed(body));

const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['weather'],
};

const resultsIn = (events: readonly ModelEvent[]) =>
  events.filter(event => event.kind === 'toolResult').map(event => event.result);

/** The parts of one request, as a reader of the wire would see them. */
const shapeOf = (request: ModelRequest | undefined): readonly string[] =>
  (request?.prompt.messages ?? []).flatMap(message =>
    message.parts.map(part => `${message.role}:${part.kind}`)
  );

it('runs the tool, answers the model with it, and asks again', async () => {
  const { value, calls } = await runWith({
    options,
    tools: registry(saying('weather', 'it rains')),
    replies: [
      { deltas: [], calls: [call('tc_1', 'weather')], stop: 'tools' },
      { deltas: ['it rains outside'] },
    ],
    use: session =>
      Effect.map(Stream.runCollect(session.ask('what is it like out')), chunk => [...chunk]),
  });

  expect(calls).toHaveLength(2);
  /* The second request carries the call and the result, in that order and in
     that shape. Anything else and the provider refuses the request outright. */
  expect(shapeOf(calls[1])).toEqual([
    'user:text',
    'assistant:toolCall',
    'user:toolResult',
  ]);
  expect(resultsIn(value)).toEqual([{ callId: 'tc_1', body: 'it rains', failed: false }]);
});

it('writes the question, the call, the result and the answer as one exchange', async () => {
  const store = recordingStore();
  await runWith({
    options,
    store: store.layer,
    tools: registry(saying('weather', 'it rains')),
    replies: [
      { deltas: [], calls: [call('tc_1', 'weather')], stop: 'tools' },
      { deltas: ['it rains outside'] },
    ],
    use: session => Stream.runDrain(session.ask('what is it like out')),
  });

  /* One append, holding every turn. A store that saw the call before the result
     existed would hold a session that could never be asked anything again. */
  expect(store.seen).toEqual([
    'user:what is it like out',
    'assistant:',
    'user:',
    'assistant:it rains outside',
    'flush',
  ]);
});

it('hands the model a failed result rather than failing the question', async () => {
  const broken = tool('weather', () => Effect.fail(new ToolFailure({ cause: 'no network' })));
  const { value } = await runWith({
    options,
    tools: registry(broken),
    replies: [
      { deltas: [], calls: [call('tc_1', 'weather')], stop: 'tools' },
      { deltas: ['I could not find out'] },
    ],
    use: session =>
      Effect.map(Stream.runCollect(session.ask('what is it like out')), chunk => [...chunk]),
  });

  const [result] = resultsIn(value);
  expect(result?.failed).toBe(true);
  /* The model is told what went wrong, because it is the only party that can
     decide whether to try again or say so. */
  expect(result?.body).toContain('no network');
});

it('refuses a tool the session does not offer, and says so to the model', async () => {
  const { value } = await runWith({
    options,
    tools: registry(saying('weather', 'it rains')),
    replies: [
      { deltas: [], calls: [call('tc_1', 'stocks')], stop: 'tools' },
      { deltas: ['I cannot do that'] },
    ],
    use: session =>
      Effect.map(Stream.runCollect(session.ask('what is it like out')), chunk => [...chunk]),
  });

  const [result] = resultsIn(value);
  expect(result).toMatchObject({ callId: 'tc_1', failed: true });
  expect(result?.body).toContain('no tool named stocks');
});

it('runs the calls of one turn at once, and serialises the tool that refuses to overlap', async () => {
  const order: string[] = [];
  const slow = (name: string, concurrent?: boolean) =>
    tool(
      name,
      () =>
        Effect.sync(() => order.push(`${name} in`)).pipe(
          Effect.zipRight(Effect.sleep(Duration.millis(20))),
          Effect.zipRight(Effect.sync(() => order.push(`${name} out`))),
          Effect.as('done')
        ),
      concurrent
    );

  await runWith({
    options: { ...options, tools: ['a', 'b', 'serial'] },
    tools: registry(slow('a'), slow('b'), slow('serial', false)),
    replies: [
      {
        deltas: [],
        calls: [
          call('tc_1', 'a'),
          call('tc_2', 'b'),
          call('tc_3', 'serial'),
          call('tc_4', 'serial'),
        ],
        stop: 'tools',
      },
      { deltas: ['done'] },
    ],
    use: session => Stream.runDrain(session.ask('go')),
  });

  /* `a` and `b` overlap: both are in before either is out. */
  expect(order.slice(0, 2).toSorted()).toEqual(['a in', 'b in']);
  /* The two calls to `serial` do not: the second waits for the first to leave. */
  const serial = order.filter(step => step.startsWith('serial'));
  expect(serial).toEqual(['serial in', 'serial out', 'serial in', 'serial out']);
});

it('stops offering tools at the round ceiling and asks for an answer in words', async () => {
  const { calls } = await runWith({
    options: { ...options, maxRounds: 2 },
    tools: registry(saying('weather', 'it rains')),
    /* A model that never stops asking. Without the ceiling this never returns. */
    replies: [{ deltas: [], calls: [call('tc_1', 'weather')], stop: 'tools' }],
    use: session => Stream.runDrain(session.ask('what is it like out')),
  });

  /* Two rounds with the tools, then one without. The last one cannot ask for
     anything, so the exchange ends on something the model said. */
  expect(calls).toHaveLength(3);
  expect(calls.slice(0, 2).map(request => request.tools?.length)).toEqual([1, 1]);
  expect(calls[2]?.tools).toBeUndefined();
});

it('keeps every turn of the exchange in the history, in the order they happened', async () => {
  const { value } = await runWith({
    options,
    tools: registry(saying('weather', 'it rains')),
    replies: [
      { deltas: ['let me look'], calls: [call('tc_1', 'weather')], stop: 'tools' },
      { deltas: ['it rains outside'] },
    ],
    use: session =>
      Effect.zipRight(Stream.runDrain(session.ask('what is it like out')), session.history),
  });

  expect(texts(value)).toEqual([
    'user:what is it like out',
    'assistant:let me look',
    'user:',
    'assistant:it rains outside',
  ]);
});

it('offers no tools at all to a session that named none', async () => {
  const { calls } = await runWith({
    replies: [{ deltas: ['hello'] }],
    use: session => Stream.runDrain(session.ask('hi')),
  });

  expect(calls[0]?.tools).toBeUndefined();
});

it('counts what every round cost, not only the last', async () => {
  const { value } = await runWith({
    options,
    tools: registry(saying('weather', 'it rains')),
    replies: [
      {
        deltas: [],
        calls: [call('tc_1', 'weather')],
        stop: 'tools',
        usage: { inputTokens: 10, outputTokens: 3 },
      },
      { deltas: ['it rains'], usage: { inputTokens: 20, outputTokens: 5 } },
    ],
    use: session => Effect.zipRight(Stream.runDrain(session.ask('out?')), session.usage),
  });

  /* A caller reading `usage` to know what a question cost must see every round
     of it. One question is now several billed calls. */
  expect(value).toMatchObject({ inputTokens: 30, outputTokens: 8 });
});

it('leaves nothing behind when the caller walks away mid-loop', async () => {
  const store = recordingStore();
  const ran: string[] = [];
  await runWith({
    options,
    store: store.layer,
    tools: registry(
      tool('weather', () =>
        Effect.sync(() => {
          ran.push('weather');
          return 'it rains';
        })
      )
    ),
    replies: [
      { deltas: [], calls: [call('tc_1', 'weather')], stop: 'tools' },
      { deltas: ['a'], stall: true },
    ],
    use: session =>
      Effect.ignore(
        Effect.timeout(Stream.runDrain(session.ask('out?')), Duration.millis(50))
      ),
  });

  /* The tool ran, and nothing was written: the exchange never finished, so the
     store holds no call and no half answer. */
  expect(ran).toEqual(['weather']);
  expect(store.seen).toEqual(['flush']);
});
