/* eslint-disable typescript-eslint/consistent-type-assertions, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-return, typescript-eslint/require-await, require-await, promise/prefer-await-to-then -- a llama.rn context is a JSI object and a download is a pending promise: a test double can only be built by asserting its shape */
import { type ModelEvent, type ModelRequest } from '@kilocode/harness-sdk';
import { Chunk, Effect, Either, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { backendFailureKey } from './backend-target';
import { type GgufContext, ggufModelClient } from './gguf-client';
import { type GgufModelFile } from './gguf-records';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const FILE: GgufModelFile = { path: '/models/a.gguf', contextWindow: 2048, tools: true };
const NO_TOOLS: GgufModelFile = { ...FILE, tools: false };

const chatCaps = { tools: true, toolCalls: true, systemRole: true, parallelToolCalls: false };
const TOOL_TEMPLATE = { llamaChat: false, jinja: { default: true, defaultCaps: chatCaps } };
const PLAIN_TEMPLATE = { llamaChat: true, jinja: { default: false } };

type Completion = (params: unknown, onToken?: (data: unknown) => void) => Promise<unknown>;

/** A context whose model description and native call are scripted. */
function contextOf(chatTemplates: unknown, completion: Completion) {
  const stopCompletion = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const context = {
    model: { chatTemplates },
    completion,
    stopCompletion,
    release,
  } as unknown as GgufContext;
  return { context, stopCompletion, release };
}

function clientWith(contexts: readonly GgufContext[], file: GgufModelFile = FILE, files = ['a']) {
  let index = 0;
  const init = vi.fn(async () => {
    const context = contexts[index];
    index += 1;
    if (context === undefined) {
      throw new Error('no context left');
    }
    return context;
  });
  return {
    init,
    ...ggufModelClient({ runtime: { init }, fileOf: id => (files.includes(id) ? file : undefined) }),
  };
}

const SHORT_ANSWER: Completion = async () => ({
  text: 'ok',
  tokens_evaluated: 1,
  tokens_predicted: 1,
  stopped_eos: true,
});

const request: ModelRequest = {
  model: 'a',
  maxTokens: 4096,
  tools: [{ name: 'time', description: 'now', parameters: { type: 'object', properties: {} } }],
  prompt: {
    system: [{ text: 'Be brief.', cache: false }],
    messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Hi' }] }],
  },
};

async function collect(stream: Stream.Stream<ModelEvent, unknown>) {
  return [...Chunk.toReadonlyArray(await Effect.runPromise(Stream.runCollect(stream)))];
}

function doneOf(events: readonly ModelEvent[]) {
  const last = events.at(-1);
  return last?.kind === 'done' ? last : undefined;
}

function textOf(events: readonly ModelEvent[]) {
  return events.flatMap(event => (event.kind === 'delta' ? [event.text] : []));
}

/** The promise of an answer's failure, which is how a refusal is observed. */
async function refusal(stream: Stream.Stream<ModelEvent, unknown>) {
  const outcome = await Effect.runPromise(Effect.either(Stream.runCollect(stream)));
  return Either.isLeft(outcome) ? backendFailureKey(outcome.left) : 'none';
}

describe('an answer over a downloaded model', () => {
  it('streams parsed deltas and reports the real usage and stop reason', async () => {
    const asked: unknown[] = [];
    const { context } = contextOf(TOOL_TEMPLATE, async (params, onToken) => {
      asked.push(params);
      onToken?.({ token: 'Hel', content: 'Hel', accumulated_text: 'Hel' });
      onToken?.({ token: 'lo', content: 'Hello', accumulated_text: 'Hello' });
      return {
        text: 'Hello',
        content: 'Hello',
        accumulated_text: 'Hello',
        tool_calls: [],
        tokens_evaluated: 7,
        tokens_predicted: 2,
        interrupted: false,
        context_full: false,
        stopped_eos: true,
        stopped_word: false,
        stopped_limit: false,
      };
    });
    const { client, init } = clientWith([context]);
    const events = await collect(client.stream(request));

    expect(init).toHaveBeenCalledWith({ model: '/models/a.gguf', n_ctx: 2048, n_parallel: 1 });
    expect(textOf(events)).toEqual(['Hel', 'lo']);
    expect(doneOf(events)?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(doneOf(events)?.stop).toBe('end');
  });

  it('sends tool definitions only for a model whose template renders tools', async () => {
    const asked: { tools?: unknown }[] = [];
    const answer: Completion = async params => {
      asked.push(params as { tools?: unknown });
      return { text: 'ok', tokens_evaluated: 1, tokens_predicted: 1, stopped_eos: true };
    };
    await collect(clientWith([contextOf(TOOL_TEMPLATE, answer).context]).client.stream(request));
    expect(asked[0]?.tools).toHaveLength(1);

    await collect(
      clientWith([contextOf(PLAIN_TEMPLATE, answer).context], NO_TOOLS).client.stream(request)
    );
    expect(asked[1]?.tools).toBeUndefined();
  });

  it('maps returned tool calls to events with stable ids', async () => {
    const { context } = contextOf(TOOL_TEMPLATE, async () => ({
      text: '{"name":"time"}',
      content: '',
      accumulated_text: '{"name":"time"}',
      tool_calls: [
        { id: 'call-7', function: { name: 'time', arguments: '{"zone":"UTC"}' } },
        { function: { name: 'time', arguments: '{}' } },
      ],
      tokens_evaluated: 3,
      tokens_predicted: 4,
      stopped_eos: false,
      stopped_limit: false,
    }));
    const events = await collect(clientWith([context]).client.stream(request));
    const calls = events.flatMap(event => (event.kind === 'toolCall' ? [event.call] : []));
    expect(calls[0]).toEqual({ id: 'call-7', name: 'time', arguments: '{"zone":"UTC"}' });
    expect(calls[1]?.name).toBe('time');
    expect(calls[1]?.id).toMatch(/^gguf-\d+-call-1$/);
    expect(doneOf(events)?.stop).toBe('tools');
  });
});

describe('the busy rule', () => {
  it('refuses a second answer while one runs and frees the model when it ends', async () => {
    const gate = Promise.withResolvers<boolean>();
    const { context } = contextOf(TOOL_TEMPLATE, async () => {
      await gate.promise;
      return { text: 'ok', tokens_evaluated: 1, tokens_predicted: 1, stopped_eos: true };
    });
    const { client } = clientWith([context]);
    const first = collect(client.stream(request));
    expect(await refusal(client.stream(request))).toBe('modelChat.localModels.busy');
    gate.resolve(true);
    expect(doneOf(await first)?.stop).toBe('end');
    expect(doneOf(await collect(client.stream(request)))?.stop).toBe('end');
  });

  it('fails explicitly for a model that is not downloaded', async () => {
    const { client } = clientWith([], FILE, []);
    expect(await refusal(client.stream(request))).toBe('modelChat.localModels.unavailable');
  });
});

describe('interrupting and releasing', () => {
  it('stops the native call when the answer is interrupted', async () => {
    const stopCompletion = vi.fn(async () => undefined);
    const context = {
      model: { chatTemplates: TOOL_TEMPLATE },
      completion: (async (_params: unknown, onToken?: (data: unknown) => void) => {
        onToken?.({ token: 'Hel', content: 'Hel', accumulated_text: 'Hel' });
        const never = new Promise<never>(() => undefined);
        return never;
      }) as unknown as GgufContext['completion'],
      stopCompletion,
      release: vi.fn(async () => undefined),
    } as unknown as GgufContext;
    const heard: string[] = [];
    await Effect.runPromise(
      Stream.runForEach(clientWith([context]).client.stream(request), event =>
        Effect.sync(() => {
          if (event.kind === 'delta') {
            heard.push(event.text);
          }
        })
      ).pipe(Effect.timeout('50 millis'), Effect.ignore)
    );
    expect(heard).toEqual(['Hel']);
    expect(stopCompletion).toHaveBeenCalled();
  });

  it('frees the loaded context on release, and only for the model it holds', async () => {
    const first = contextOf(PLAIN_TEMPLATE, SHORT_ANSWER);
    const second = contextOf(PLAIN_TEMPLATE, SHORT_ANSWER);
    const { client, release, init } = clientWith([first.context, second.context]);
    await collect(client.stream(request));
    await release('other');
    expect(first.release).not.toHaveBeenCalled();
    await release('a');
    expect(first.release).toHaveBeenCalledTimes(1);
    await collect(client.stream(request));
    expect(init).toHaveBeenCalledTimes(2);
  });
});
