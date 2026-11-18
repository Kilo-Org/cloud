import { type ModelRequest } from '@kilocode/harness-sdk';
import { Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { nativeModelClient } from './native-model-client';
import { AVAILABLE, collect, fakeBridge, request } from './native-model-client.test-helpers';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const call = { id: 'clock-call', name: 'time', arguments: '{}' };

function answered(id: string): ModelRequest {
  return {
    ...request,
    prompt: {
      ...request.prompt,
      messages: [
        ...request.prompt.messages,
        {
          role: 'assistant',
          cache: false,
          parts: [{ kind: 'toolCall', callId: id, name: 'time', arguments: '{}' }],
        },
        {
          role: 'user',
          cache: false,
          parts: [{ kind: 'toolResult', callId: id, body: 'noon', failed: false }],
        },
      ],
    },
  };
}

describe('native generation text across tool rounds', () => {
  it.each(['The answer is noon.', ''])(
    'keeps prior text ownership when the final round adds no text: %j',
    async text => {
      const fake = fakeBridge((native, emit) => {
        if (text) {
          emit({ id: native.id, kind: 'delta', text });
        }
        emit({ id: native.id, kind: 'toolCalls', calls: [call] });
      });
      fake.bridge.availability.mockResolvedValue({ ...AVAILABLE, tools: true });
      const bridge = {
        ...fake.bridge,
        resume: vi.fn(async (id: string) => {
          await Promise.resolve();
          fake.emit({ id, kind: 'done', stop: 'end', usageSource: 'unavailable' });
        }),
      };
      const client = nativeModelClient(bridge);
      await collect(bridge, client.stream(request));
      const result = await collect(bridge, client.stream(answered(call.id)));
      if (text) {
        expect(Result.isSuccess(result) && [...result.success]).toEqual([
          expect.objectContaining({ kind: 'done', stop: 'end' }),
        ]);
      } else {
        expect(Result.isFailure(result)).toBe(true);
      }
    }
  );

  it('retains earlier answer text through another tool-only round', async () => {
    const secondCall = { ...call, id: 'second-clock-call' };
    const fake = fakeBridge((native, emit) => {
      emit({ id: native.id, kind: 'delta', text: 'The answer is noon.' });
      emit({ id: native.id, kind: 'toolCalls', calls: [call] });
    });
    fake.bridge.availability.mockResolvedValue({ ...AVAILABLE, tools: true });
    let round = 0;
    const bridge = {
      ...fake.bridge,
      resume: vi.fn(async (id: string) => {
        await Promise.resolve();
        round += 1;
        if (round === 1) {
          fake.emit({ id, kind: 'toolCalls', calls: [secondCall] });
        } else {
          fake.emit({ id, kind: 'done', stop: 'end', usageSource: 'unavailable' });
        }
      }),
    };
    const client = nativeModelClient(bridge);
    await collect(bridge, client.stream(request));
    await collect(bridge, client.stream(answered(call.id)));
    const result = await collect(bridge, client.stream(answered(secondCall.id)));
    expect(Result.isSuccess(result) && [...result.success]).toEqual([
      expect.objectContaining({ kind: 'done', stop: 'end' }),
    ]);
  });
});
