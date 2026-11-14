import { type ModelClientService, type ModelEvent, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Result, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  type NativeAvailability,
  nativeModelClient,
  releaseNativeModelRound,
} from './native-model-client';
import {
  answerWith,
  AVAILABLE,
  call,
  fakeBridge,
  request,
  type Script,
} from './native-model-client.test-helpers';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const TOOLS: NativeAvailability = { ...AVAILABLE, tools: true };

/** Everything one answer produced, failing loudly if it failed. */
async function said(client: ModelClientService, asked = request): Promise<ModelEvent[]> {
  const result = await Effect.runPromise(Effect.result(Stream.runCollect(client.stream(asked))));
  if (Result.isFailure(result)) {
    throw new Error('Expected the answer to finish');
  }
  return [...result.success];
}

/** A bridge whose every generation pauses on one tool call first. */
function toolBridge(script: Script) {
  const fake = fakeBridge(script);
  fake.bridge.availability.mockResolvedValue(TOOLS);
  return fake;
}

/** One chat asks, pauses on a tool call, and its round is left waiting. */
async function pausedRound() {
  let round = 0;
  const { bridge } = toolBridge((native, send) => {
    round += 1;
    if (round === 1) {
      send({ id: native.id, kind: 'toolCalls', calls: [call] });
      return;
    }
    send({ id: native.id, kind: 'delta', text: 'Fresh answer.' });
    send({ id: native.id, kind: 'done', stop: 'end', usageSource: 'unavailable' });
  });
  const client = nativeModelClient(bridge);
  await said(client);
  return { bridge, client, paused: bridge.generate.mock.calls[0]?.[0].id };
}

describe('releasing an abandoned on-device round', () => {
  it('releases the round its chat abandoned, so another chat can ask', async () => {
    // Stop, a deleted chat, or a sign-out ends the exchange while its tools run:
    // the round can never be answered, and every later ask would be refused.
    const { bridge, client, paused } = await pausedRound();

    // Another chat's release touches nothing.
    await releaseNativeModelRound('chat-b');
    expect(bridge.cancel).not.toHaveBeenCalled();

    await releaseNativeModelRound('chat-a');
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(paused);
    expect(bridge.generate).toHaveBeenCalledOnce();

    const next = await said(client, { ...request, cacheKey: 'chat-b' } satisfies ModelRequest);
    expect(next.map(event => event.kind)).toEqual(['delta', 'done']);
    expect(bridge.generate).toHaveBeenCalledTimes(2);
    expect(bridge.generate.mock.calls[1]?.[0].id).not.toBe(paused);
  });

  it('releases nothing when no round is waiting', async () => {
    const { bridge } = toolBridge(answerWith({}));
    await said(nativeModelClient(bridge));

    await releaseNativeModelRound('chat-a');

    expect(bridge.cancel).not.toHaveBeenCalled();
  });
});
