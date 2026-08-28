/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free renderer exercises the hook without a native screen */
/* eslint-disable max-lines -- the mounted hook shares one real gateway and in-memory persistence harness */
/* eslint-disable promise/prefer-await-to-then -- race tests attach rejection handlers before changing the owner */
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppStateStatus } from 'react-native';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { beginAuthenticatedOwner, confirmAuthenticatedOwner } from '@/lib/context-scope';
import {
  initializeLocalAccess,
  LocalAccessDeniedError,
  lockLocalAccess,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import { type AcceptedWorkReceipt } from '@/lib/local-access-transport';
import * as gateway from './quick-chat-gateway';
import { useQuickChat } from './use-quick-chat';

const state = vi.hoisted(() => ({
  ready: true,
  token: vi.fn(),
  thread: vi.fn(),
  toast: vi.fn(),
  persisted: new Map<string, unknown>(),
  reads: [] as string[],
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('sonner-native', () => ({ toast: { error: state.toast } }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://gateway.test' }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: state.token }));
vi.mock('@/lib/organization-context', async () => {
  const { useSyncExternalStore } = await import('react');
  const { getAuthenticatedOwner: snapshot, subscribeAuthenticatedOwner: subscribe } =
    await import('@/lib/context-scope');
  return {
    useOrganization: () => ({
      owner: useSyncExternalStore(subscribe, snapshot),
      isReady: state.ready,
      organizationId: 'org-A',
    }),
  };
});
vi.mock('@/lib/trpc', async () => {
  const { captureTransportOperation } = await import('@/lib/local-access-transport');
  type Options = { context?: Record<string, unknown> };
  return {
    useTRPC: () => ({
      quickChat: {
        listMessages: { queryKey: (input: unknown) => [['quickChat', 'listMessages'], { input }] },
      },
    }),
    trpcClient: {
      quickChat: {
        listMessages: {
          query: async (input: unknown, options: Options = {}) => {
            const operation = captureTransportOperation({
              id: 1,
              type: 'query',
              path: 'quickChat.listMessages',
              input,
              context: options.context ?? {},
              signal: undefined,
            });
            operation.assertDispatch();
            state.reads.push(operation.owner.userId ?? 'none');
            await Promise.resolve();
            return { messages: [], nextCursor: null };
          },
        },
        getOrCreateThread: {
          mutate: async (input: unknown, options: Options = {}) => {
            const operation = captureTransportOperation({
              id: 2,
              type: 'mutation',
              path: 'quickChat.getOrCreateThread',
              input,
              context: options.context ?? {},
              signal: undefined,
            });
            await state.thread();
            operation.assertDispatch();
            return { id: 'thread-A' };
          },
        },
        appendMessages: {
          mutate: async (
            input: { organizationId: string; messages: unknown[] },
            options: Options = {}
          ) => {
            const operation = captureTransportOperation({
              id: 3,
              type: 'mutation',
              path: 'quickChat.appendMessages',
              input,
              context: options.context ?? {},
              signal: undefined,
            });
            operation.assertDispatch();
            state.persisted.set(
              `${operation.owner.userId}:${input.organizationId}`,
              input.messages
            );
            await Promise.resolve();
            return { accepted: true };
          },
        },
      },
    },
  };
});

let current: ReturnType<typeof useQuickChat> | undefined = undefined;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let queryClient: QueryClient | undefined = undefined;
let stop: (() => void) | undefined = undefined;
let lifecycle: (next: AppStateStatus) => void = () => undefined;
const fetchMock = vi.fn<typeof fetch>();
function Probe() {
  current = useQuickChat('model');
  return null;
}
function hook() {
  if (!current) {
    throw new Error('Hook not mounted');
  }
  return current;
}
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient = client;
  await act(() => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(Probe))
    );
  });
}
async function send(text = 'hello') {
  let pending: Promise<PromiseSettledResult<AcceptedWorkReceipt>[]> = Promise.resolve([]);
  await act(() => {
    pending = Promise.allSettled([hook().onSend(text)]);
  });
  const [settlement] = await pending;
  if (settlement?.status === 'fulfilled') {
    return settlement.value;
  }
  const error: unknown = settlement?.reason;
  throw error instanceof Error ? error : new Error('Missing dispatch settlement');
}
async function stream() {
  const pending = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      pending.resolve(controller);
    },
  });
  fetchMock.mockResolvedValue(new Response(body));
  const controller = await pending.promise;
  return controller;
}
async function finish(controller: ReadableStreamDefaultController<Uint8Array>, text = 'answer') {
  await act(async () => {
    controller.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
      )
    );
    controller.close();
    await Promise.resolve();
  });
}
beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock.mockReset();
  state.ready = true;
  state.token.mockReset().mockResolvedValue('token-A');
  state.thread.mockReset().mockResolvedValue(undefined);
  state.toast.mockReset();
  state.persisted.clear();
  state.reads.length = 0;
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  stop = initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'absent' }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: {
      getCurrentState: () => 'active',
      subscribe: listener => {
        lifecycle = listener;
        return () => undefined;
      },
    },
  });
  await setLocalAccessOwner('A', currentAuthEpoch());
  setLocalAccessContextReady(true);
});
afterEach(async () => {
  await act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  current = undefined;
  queryClient?.clear();
  stop?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Quick Chat accepted completion ownership', () => {
  it('persists a complete background turn with locking disabled and settles dispatch before its answer', async () => {
    const controller = await stream();
    await mount();
    const nativePromises = vi.spyOn(Promise, 'withResolvers').mockImplementation(() => {
      throw new Error('Native Promise lacks withResolvers');
    });
    try {
      await send();
    } finally {
      nativePromises.mockRestore();
    }
    expect(hook().isStreaming).toBe(true);
    expect(state.persisted.size).toBe(0);
    lifecycle('background');
    await finish(controller);
    await vi.waitFor(() => {
      expect(state.persisted.get('A:org-A')).toEqual([
        expect.objectContaining({ role: 'user', content: 'hello', clientId: expect.any(String) }),
        { role: 'assistant', content: 'answer' },
      ]);
    });
  });

  it('persists an admitted turn after locking and never starts a replacement turn automatically', async () => {
    await requestLocalAccess('enable');
    const controller = await stream();
    await mount();
    await send();
    lockLocalAccess();
    await finish(controller);
    await vi.waitFor(() => {
      expect(state.persisted.has('A:org-A')).toBe(true);
    });
    await requestLocalAccess('unlock');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects final dispatch after a token wait crosses lock/unlock and keeps persistence empty', async () => {
    await requestLocalAccess('enable');
    const token = Promise.withResolvers<string>();
    state.token.mockReturnValue(token.promise);
    await mount();
    let outcome: PromiseSettledResult<AcceptedWorkReceipt>[] = [];
    let pending: Promise<PromiseSettledResult<AcceptedWorkReceipt>[]> = Promise.resolve([]);
    await act(() => {
      pending = Promise.allSettled([hook().onSend('retain draft')]);
    });
    await vi.waitFor(() => {
      expect(state.token).toHaveBeenCalled();
    });
    lockLocalAccess();
    await requestLocalAccess('unlock');
    token.resolve('token-A');
    await act(async () => {
      outcome = await pending;
    });
    expect(outcome).toEqual([{ status: 'rejected', reason: expect.any(LocalAccessDeniedError) }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.persisted.size).toBe(0);
    expect(hook().messages).toEqual([]);
  });

  it('cancels A completion and hides its rows when B replaces the account', async () => {
    const controller = await stream();
    await mount();
    await send('private A prompt');
    await act(async () => {
      bumpAuthEpoch();
      confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
      await setLocalAccessOwner('B', currentAuthEpoch());
      setLocalAccessContextReady(true);
    });
    await finish(controller, 'private A answer');
    expect(state.persisted.size).toBe(0);
    expect(hook().messages).toEqual([]);
    expect(
      queryClient
        ?.getQueryCache()
        .getAll()
        .map(query => query.queryKey)
    ).toEqual(
      expect.arrayContaining([expect.arrayContaining(['A']), expect.arrayContaining(['B'])])
    );
  });

  it('does not read or create a thread before the context is ready', async () => {
    state.ready = false;
    await mount();
    expect(() => {
      void hook().onSend('draft');
    }).toThrow(LocalAccessDeniedError);
    expect(hook().isLoading).toBe(true);
    expect(state.reads).toEqual([]);
    expect(state.thread).not.toHaveBeenCalled();
    expect(state.persisted.size).toBe(0);
  });

  it('normalizes a non-Error token failure without dispatch or persistence', async () => {
    state.token.mockRejectedValueOnce('native token failure');
    await mount();
    let pending: Promise<PromiseSettledResult<AcceptedWorkReceipt>[]> = Promise.resolve([]);
    await act(() => {
      pending = Promise.allSettled([hook().onSend('draft')]);
    });
    expect(await pending).toEqual([{ status: 'rejected', reason: expect.any(Error) }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.persisted.size).toBe(0);
  });

  it('rejects a forged gateway receipt instead of persisting the turn', async () => {
    vi.spyOn(gateway, 'streamQuickChatCompletion').mockImplementation(
      async function* forgedCompletion(input) {
        await Promise.resolve();
        const forged = {};
        input.onDispatch(forged as AcceptedWorkReceipt);
        yield 'forged answer';
      }
    );
    await mount();
    await expect(send()).rejects.toBeInstanceOf(LocalAccessDeniedError);
    expect(state.persisted.size).toBe(0);
  });
});
