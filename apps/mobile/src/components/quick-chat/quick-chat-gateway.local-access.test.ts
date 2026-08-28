/* eslint-disable promise/prefer-await-to-then -- race tests attach rejection handlers before changing the owner */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  initializeLocalAccess,
  LocalAccessDeniedError,
  lockLocalAccess,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import {
  type AcceptedWorkReceipt,
  assertAcceptedWorkReceipt,
  captureMobileActionAdmission,
} from '@/lib/local-access-transport';
import { type QuickChatCompletionInput, streamQuickChatCompletion } from './quick-chat-gateway';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://gateway.test' }));
const fetchMock = vi.fn<typeof fetch>();
let stop: (() => void) | undefined = undefined;
beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  stop = initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'present', enabled: true }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => () => undefined },
  });
  await setLocalAccessOwner('A', currentAuthEpoch());
  setLocalAccessContextReady(true);
  await requestLocalAccess('unlock', true);
});
afterEach(() => {
  stop?.();
  vi.unstubAllGlobals();
});
async function collect(stream: AsyncGenerator<string>) {
  const values: string[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values.join('');
}
function input(): QuickChatCompletionInput {
  return {
    model: 'model',
    messages: [{ role: 'user', content: 'hello' }],
    organizationId: 'org-A',
    authToken: 'token-A',
    turnId: 'turn-A',
    admission: captureMobileActionAdmission(getAuthenticatedOwner(), 'org-A'),
    onDispatch: () => undefined,
  };
}
function streamBody() {
  const chunks = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.resolve(controller);
    },
  });
  return { body, controller: chunks.promise };
}
function content(text: string) {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  );
}

describe('Quick Chat final dispatch', () => {
  it.each(['lock/unlock', 'account replacement'] as const)(
    'denies an original turn after %s without dispatch or a receipt',
    async change => {
      const captured = input();
      const receipts: AcceptedWorkReceipt[] = [];
      captured.onDispatch = receipt => {
        receipts.push(receipt);
      };
      if (change === 'lock/unlock') {
        lockLocalAccess();
        await requestLocalAccess('unlock');
      } else {
        bumpAuthEpoch();
        confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
      }
      await expect(collect(streamQuickChatCompletion(captured))).rejects.toBeInstanceOf(
        LocalAccessDeniedError
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(receipts).toEqual([]);
    }
  );
  it('settles dispatch before headers arrive and preserves an accepted answer while locked', async () => {
    const response = Promise.withResolvers<Response>();
    const admitted = Promise.withResolvers<AcceptedWorkReceipt>();
    fetchMock.mockReturnValue(response.promise);
    const pending = collect(
      streamQuickChatCompletion({ ...input(), onDispatch: admitted.resolve })
    );
    const receipt = await admitted.promise;
    lockLocalAccess();
    expect(() =>
      assertAcceptedWorkReceipt(receipt, {
        kind: 'quick-chat-turn',
        organizationId: 'org-A',
        workId: 'turn-A',
      })
    ).not.toThrow();
    const stream = streamBody();
    response.resolve(new Response(stream.body));
    const controller = await stream.controller;
    controller.enqueue(content('accepted reply'));
    controller.close();
    await expect(pending).resolves.toBe('accepted reply');
  });
  it('drops a parsed A delta after account replacement', async () => {
    const stream = streamBody();
    fetchMock.mockResolvedValue(new Response(stream.body));
    const admitted = Promise.withResolvers<AcceptedWorkReceipt>();
    const pending = Promise.allSettled([
      collect(streamQuickChatCompletion({ ...input(), onDispatch: admitted.resolve })),
    ]);
    await admitted.promise;
    bumpAuthEpoch();
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
    const controller = await stream.controller;
    controller.enqueue(content('private A reply'));
    controller.close();
    expect(await pending).toEqual([
      { status: 'rejected', reason: expect.any(LocalAccessDeniedError) },
    ]);
  });
  it('rejects a pre-aborted native signal without dispatch or a receipt', async () => {
    const legacySignal = { aborted: true };
    const receipts: AcceptedWorkReceipt[] = [];
    await expect(
      collect(
        streamQuickChatCompletion({
          ...input(),
          signal: legacySignal as AbortSignal,
          onDispatch: receipt => {
            receipts.push(receipt);
          },
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(receipts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('denies a mismatched organization before reaching the gateway', async () => {
    await expect(
      collect(streamQuickChatCompletion({ ...input(), organizationId: 'org-B' }))
    ).rejects.toMatchObject({ reason: 'context' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not publish a receipt when native fetch throws synchronously', async () => {
    const receipts: AcceptedWorkReceipt[] = [];
    fetchMock.mockImplementation(() => {
      throw new Error('native dispatch failed');
    });
    await expect(
      collect(
        streamQuickChatCompletion({
          ...input(),
          onDispatch: receipt => {
            receipts.push(receipt);
          },
        })
      )
    ).rejects.toThrow('native dispatch failed');
    expect(receipts).toEqual([]);
  });
});
