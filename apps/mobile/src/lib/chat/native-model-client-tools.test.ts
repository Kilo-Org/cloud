import { type ModelClientService, type ModelEvent, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Either, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { backendFailureKey } from './backend-target';
import { type NativeAvailability, nativeModelClient } from './native-model-client';
import {
  answerWith,
  AVAILABLE,
  collect,
  fakeBridge,
  request,
  type Script,
} from './native-model-client.test-helpers';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

describe('native on-device model client with tools', () => {
  const TOOLS: NativeAvailability = { ...AVAILABLE, tools: true };
  const call = { id: 'fm-call-1', name: 'time', arguments: '{}' };

  /** The request the harness sends after it ran the round's calls. */
  const answered = (results: readonly { callId: string; body: string }[]): ModelRequest => ({
    ...request,
    prompt: {
      system: request.prompt.system,
      messages: [
        ...request.prompt.messages,
        {
          role: 'assistant',
          cache: false,
          parts: [{ kind: 'toolCall', callId: call.id, name: 'time', arguments: '{}' }],
        },
        {
          role: 'user',
          cache: true,
          parts: results.map(result => ({ kind: 'toolResult', ...result, failed: false }) as const),
        },
      ],
    },
  });

  async function said(client: ModelClientService, asked = request): Promise<ModelEvent[]> {
    const result = await Effect.runPromise(Effect.either(Stream.runCollect(client.stream(asked))));
    if (Either.isLeft(result)) {
      throw new Error('Expected the answer to finish');
    }
    return [...result.right];
  }

  function toolBridge(script: Script) {
    const fake = fakeBridge(script);
    fake.bridge.availability.mockResolvedValue(TOOLS);
    return fake;
  }

  it('sends paired tool calls and outputs, and the tools Foundation Models can take', async () => {
    const { bridge } = toolBridge(answerWith({}));
    const asked: ModelRequest = {
      ...request,
      tools: [
        ...(request.tools ?? []),
        {
          name: 'lookup',
          description: 'Looks something up',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'What to find' } },
            required: ['query'],
          },
        },
        {
          name: 'merge',
          description: 'Needs a union',
          parameters: {
            type: 'object',
            properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
            required: ['value'],
          },
        },
      ],
      prompt: {
        ...request.prompt,
        messages: [
          {
            role: 'assistant',
            cache: false,
            parts: [{ kind: 'toolCall', callId: 'never-answered', name: 'time', arguments: '{}' }],
          },
          ...request.prompt.messages,
        ],
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await said(nativeModelClient(bridge), asked);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[native-model] tool left out: merge.value: anyOf'
    );
    warn.mockRestore();
    expect(bridge.generate).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      system: 'Be brief.\n\nAnswer in English.',
      messages: [
        { role: 'user', text: 'What is Kilo?' },
        { role: 'assistant', text: 'A coding agent.' },
        { role: 'toolCalls', calls: [{ id: 'call', name: 'time', arguments: '{}' }] },
        { role: 'toolOutput', callId: 'call', name: 'time', text: 'noon' },
        { role: 'user', text: 'Thanks' },
      ],
      maxTokens: 1000,
      tools: [
        {
          name: 'time',
          description: 'Current time',
          parameters: JSON.stringify({ type: 'object', properties: [] }),
        },
        {
          name: 'lookup',
          description: 'Looks something up',
          parameters: JSON.stringify({
            type: 'object',
            properties: [
              {
                name: 'query',
                description: 'What to find',
                optional: false,
                schema: { type: 'string', description: 'What to find' },
              },
            ],
          }),
        },
      ],
    });
  });

  it('ends the round on the calls, then resumes the same generation with their results', async () => {
    const { bridge, emit } = toolBridge((native, send) => {
      send({ id: native.id, kind: 'toolCalls', calls: [call] });
    });
    const client = nativeModelClient(bridge);
    expect(await said(client)).toEqual([
      { kind: 'toolCall', call },
      {
        kind: 'done',
        stop: 'tools',
        usage: expect.objectContaining({ cacheReadTokens: 0, cacheWriteTokens: 0 }),
      },
    ]);
    // The generation waits for the results; nothing stops it.
    expect(bridge.cancel).not.toHaveBeenCalled();
    const id = bridge.generate.mock.calls[0]?.[0].id ?? '';

    bridge.resume.mockImplementation(async resumed => {
      // The native module sends its events after it receives the results.
      await Promise.resolve();
      emit({ id: resumed, kind: 'delta', text: 'It is noon.' });
      emit({
        id: resumed,
        kind: 'done',
        stop: 'end',
        usageSource: 'counted',
        inputTokens: 90,
        outputTokens: 4,
      });
    });
    const second = await said(client, answered([{ callId: call.id, body: '12:00' }]));
    expect(bridge.resume).toHaveBeenCalledExactlyOnceWith(id, [{ callId: call.id, body: '12:00' }]);
    expect(bridge.generate).toHaveBeenCalledOnce();
    expect(second).toEqual([
      { kind: 'delta', text: 'It is noon.' },
      {
        kind: 'done',
        stop: 'end',
        usage: { inputTokens: 90, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('stops a waiting generation that a new question leaves behind', async () => {
    let round = 0;
    const { bridge } = toolBridge((native, send) => {
      round += 1;
      if (round === 1) {
        send({ id: native.id, kind: 'toolCalls', calls: [call] });
      } else {
        answerWith({})(native, send);
      }
    });
    const client = nativeModelClient(bridge);
    await said(client);
    const waiting = bridge.generate.mock.calls[0]?.[0].id;
    const next = await said(client);
    expect(next.at(-1)).toMatchObject({ kind: 'done', stop: 'end' });
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(waiting);
    expect(bridge.resume).not.toHaveBeenCalled();
    expect(bridge.generate).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly on results that answer no waiting generation', async () => {
    const { bridge } = toolBridge((native, send) => {
      send({ id: native.id, kind: 'toolCalls', calls: [call] });
    });
    const client = nativeModelClient(bridge);
    await said(client);
    const waiting = bridge.generate.mock.calls[0]?.[0].id;
    const result = await collect(bridge, client.stream(answered([{ callId: 'other', body: 'x' }])));
    expect(Either.isLeft(result) && backendFailureKey(result.left)).toBe(
      'modelChat.localModels.failed'
    );
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(waiting);
    expect(bridge.resume).not.toHaveBeenCalled();
    expect(bridge.generate).toHaveBeenCalledOnce();
  });

  it('keeps a provider without the tool loop text-only', async () => {
    const { bridge } = toolBridge(answerWith({}));
    await said(nativeModelClient({ ...bridge, resume: undefined }));
    const sent = bridge.generate.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty('tools');
    expect(sent?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
  });
});
