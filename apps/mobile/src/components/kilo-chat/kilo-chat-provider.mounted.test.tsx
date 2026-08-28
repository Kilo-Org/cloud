/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the native provider without a DOM */
/* eslint-disable require-await, typescript-eslint/require-await -- async doubles and act callbacks preserve the native promise contracts */
/* eslint-disable max-lines -- keep shared mutation regressions in the owned mounted harness with its installed renderer */
import { createElement, StrictMode, useCallback, useContext, useEffect, useRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as EventService from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  clearMarkReadRetry,
  createMarkReadRetryState,
  createMarkReadState,
  finishMarkReadAttempt,
  scheduleMarkReadRetry,
  shouldStartMarkReadAttempt,
  startMarkReadAttempt,
  succeedMarkReadAttempt,
  useEventServiceClient,
  useKiloChatClient,
  useKiloChatMutation,
  useMarkConversationRead,
} from '@kilocode/kilo-chat-hooks';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  type AuthenticatedOwner,
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  initializeLocalAccess,
  lockLocalAccess,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import {
  KiloChatCurrentUserContext,
  KiloChatProvider,
  useKiloChatTokenError,
} from './kilo-chat-provider';

const mocks = vi.hoisted(() => {
  type Handler = (context: string, payload: unknown) => void;
  class EventClient {
    static instances: EventClient[] = [];
    readonly config: EventService.EventServiceConfig;
    connected = false;
    handlers = new Map<string, Set<Handler>>();
    constructor(config: EventService.EventServiceConfig) {
      this.config = config;
      EventClient.instances.push(this);
    }
    async acquire() {
      this.connected = true;
    }
    release() {
      this.connected = false;
    }
    isConnected() {
      return this.connected;
    }
    subscribe = vi.fn<() => void>();
    on(name: string, handler: Handler) {
      const handlers = this.handlers.get(name) ?? new Set<Handler>();
      handlers.add(handler);
      this.handlers.set(name, handlers);
      return () => {
        handlers.delete(handler);
      };
    }
    onConnected(handler: () => void) {
      return this.on('connected', handler);
    }
    onReconnect(handler: () => void) {
      return this.on('reconnect', handler);
    }
    onResync(handler: () => void) {
      return this.on('resync', handler);
    }
    emit(name: string, context: string, payload: unknown) {
      for (const handler of this.handlers.get(name) ?? []) {
        handler(context, payload);
      }
    }
  }
  return {
    EventClient,
    active: true,
    tokenReads: [] as string[],
    messages: [] as string[],
    statuses: [] as boolean[],
    resyncs: 0,
  };
});
vi.mock('@kilocode/event-service', async original => ({
  ...(await original<typeof EventService>()),
  EventServiceClient: mocks.EventClient,
}));
vi.mock('@/lib/config', () => ({
  EVENT_SERVICE_URL: 'https://events.test',
  KILO_CHAT_URL: 'https://chat.test',
}));
vi.mock('./hooks/use-app-active-and-focused', () => ({
  useAppActiveAndFocused: () => mocks.active,
}));
vi.mock('./hooks/use-kilo-chat-token', () => ({
  clearKiloChatTokenCache: vi.fn<() => void>(),
  subscribeToKiloChatTokenResponses: () => vi.fn<() => void>(),
  useKiloChatTokenResponseGetter: (owner: AuthenticatedOwner) =>
    useCallback(async () => {
      mocks.tokenReads.push(owner.userId ?? 'absent');
      return {
        userId: owner.userId,
        token: `chat-${owner.userId}`,
        expiresAt: '2099-01-01T00:00:00Z',
      };
    }, [owner]),
}));

type ProbeValue = { client: KiloChatClient; userId: string | null; retry: () => void };
let probe: ProbeValue | undefined = undefined;
function Probe() {
  const client = useKiloChatClient();
  const eventService = useEventServiceClient();
  const userId = useContext(KiloChatCurrentUserContext);
  const { retry } = useKiloChatTokenError();
  probe = { client, userId, retry };
  useEffect(() => {
    const offs = [
      client.onMessageCreated((_context, event) => {
        mocks.messages.push(event.senderId);
      }),
      client.onBotStatus((_context, event) => {
        mocks.statuses.push(event.online);
      }),
      eventService.onResync(() => {
        mocks.resyncs += 1;
      }),
    ];
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }, [client, eventService]);
  return null;
}
function current() {
  if (!probe) {
    throw new Error('provider not mounted');
  }
  return probe;
}
function tree() {
  return createElement(KiloChatProvider, null, createElement(Probe));
}
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let disposeAccess: (() => void) | undefined = undefined;
async function selectOwner(userId: string) {
  bumpAuthEpoch();
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), userId);
  await setLocalAccessOwner(userId, currentAuthEpoch());
  setLocalAccessContextReady(true);
  await requestLocalAccess('unlock');
}
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
}
const messageEvent = {
  messageId: '01HV0000000000000000000001',
  senderId: 'a',
  content: [{ type: 'text', text: 'private' }],
  inReplyToMessageId: null,
  replyTo: null,
  clientId: null,
};

beforeEach(async () => {
  mocks.EventClient.instances = [];
  mocks.active = true;
  mocks.messages = [];
  mocks.statuses = [];
  mocks.tokenReads = [];
  mocks.resyncs = 0;
  probe = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', async () => Response.json({}));
  disposeAccess = initializeLocalAccess({
    storage: {
      read: async () => ({ status: 'present', enabled: true }),
      write: async () => 'committed',
    },
    authenticate: async () => ({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => vi.fn<() => void>() },
  });
  await selectOwner('a');
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  disposeAccess?.();
  vi.unstubAllGlobals();
});

describe('KiloChatProvider owner lifecycle', () => {
  it('replaces disposed clients during effect replay without reviving their queues', async () => {
    await act(async () => {
      renderer = TestRenderer.create(createElement(StrictMode, null, tree()));
    });
    await expect(current().client.sendTyping('c')).resolves.toBeUndefined();
    expect(mocks.EventClient.instances.filter(instance => instance.connected)).toHaveLength(1);
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(mocks.EventClient.instances.filter(instance => instance.connected)).toEqual([]);
  });

  it('pairs active/inactive holds without replacing the same owner clients', async () => {
    await mount();
    const original = current().client;
    const socket = mocks.EventClient.instances[0];
    expect(socket?.connected).toBe(true);
    mocks.active = false;
    await act(async () => {
      renderer?.update(tree());
    });
    expect(socket?.connected).toBe(false);
    mocks.active = true;
    await act(async () => {
      renderer?.update(tree());
    });
    expect(socket?.connected).toBe(true);
    expect(current().client).toBe(original);
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(socket?.connected).toBe(false);
    await expect(original.sendTyping('c')).rejects.toThrow('owner is no longer active');
  });

  it('keeps an inactive mount disconnected', async () => {
    mocks.active = false;
    await mount();
    expect(mocks.EventClient.instances.map(instance => instance.connected)).toEqual([false]);
  });

  it('replaces A directly with B while requests, queued sends, callbacks, and token retry remain outstanding', async () => {
    const response = Promise.withResolvers<Response>();
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      requests.push(url instanceof Request ? url.url : url.toString());
      return response.promise;
    });
    await mount();
    const old = current();
    const oldSocket = mocks.EventClient.instances[0];
    const queuedEvents = [...(oldSocket?.handlers.get('message.created') ?? [])];
    const queuedResyncs = [...(oldSocket?.handlers.get('resync') ?? [])];
    const first = old.client.sendMessage({
      conversationId: 'c',
      content: [{ type: 'text', text: 'A' }],
    });
    const queued = old.client.sendMessage({
      conversationId: 'c',
      content: [{ type: 'text', text: 'queued A' }],
    });
    const read = old.client.listConversations();
    // eslint-disable-next-line promise/prefer-await-to-then -- attach all rejections before replacing the owner
    const settled = Promise.allSettled([first, queued, read]);
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    await act(async () => {
      const replacement = selectOwner('b');
      // The subscription closes A before React mounts B.
      expect(oldSocket?.connected).toBe(false);
      await replacement;
    });
    const results = await settled;
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    response.resolve(Response.json({}));
    for (const handler of queuedEvents) {
      handler('old-context', messageEvent);
    }
    for (const handler of queuedResyncs) {
      handler('', undefined);
    }
    const tokenReads = [...mocks.tokenReads];
    old.retry();
    await expect(oldSocket?.config.getToken()).rejects.toMatchObject({ reason: 'owner' });
    expect(mocks.messages).toEqual([]);
    expect(mocks.resyncs).toBe(0);
    expect(mocks.tokenReads).toEqual(tokenReads);
    expect(current().userId).toBe('b');
    expect(current().client).not.toBe(old.client);
    expect(mocks.EventClient.instances.at(-1)?.connected).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('delivers same-owner messages and status while locked but rejects foreground commands', async () => {
    await mount();
    const owner = current().client;
    lockLocalAccess();
    const socket = mocks.EventClient.instances[0];
    socket?.emit(
      'message.created',
      EventService.kiloclawConversationContext('s', 'c'),
      messageEvent
    );
    socket?.emit('bot.status', 'instance', { sandboxId: 's', online: true, at: 1 });
    expect(mocks.messages).toEqual(['a']);
    expect(mocks.statuses).toEqual([true]);
    expect(socket?.connected).toBe(true);
    await expect(owner.sendTyping('c')).rejects.toMatchObject({
      code: 'LOCAL_ACCESS_DENIED',
      reason: 'locked',
    });
    await expect(owner.sendTypingStop('c')).resolves.toBeUndefined();
  });
});

describe('mounted shared mutation callbacks', () => {
  let queryClient: QueryClient | undefined = undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    queryClient?.clear();
    vi.useRealTimers();
  });

  async function mountQueryHook<T>(useHook: () => T) {
    let value: T | undefined = undefined;
    function HookProbe() {
      value = useHook();
      return null;
    }
    function hookTree() {
      if (!queryClient) {
        throw new Error('missing test query client');
      }
      return createElement(QueryClientProvider, { client: queryClient }, createElement(HookProbe));
    }
    await act(async () => {
      renderer = TestRenderer.create(hookTree());
    });
    return {
      get current() {
        if (value === undefined) {
          throw new Error('mutation hook not mounted');
        }
        return value;
      },
      async rerender() {
        await act(async () => {
          renderer?.update(hookTree());
        });
      },
    };
  }

  function legacyClient(fetch: typeof globalThis.fetch) {
    return new KiloChatClient({
      eventService: new EventService.EventServiceClient({
        url: 'https://events.test',
        getToken: async () => 'legacy',
      }),
      baseUrl: 'https://chat.test',
      getToken: async () => 'legacy',
      fetch,
    });
  }

  it('delays and bounds failed mark-read requests with the web effect dependency', async () => {
    const firstResponse = Promise.withResolvers<Response>();
    const requestTimes: number[] = [];
    const client = legacyClient(async () => {
      requestTimes.push(Date.now());
      return requestTimes.length === 1
        ? firstResponse.promise
        : Response.json({ error: 'unavailable' }, { status: 500 });
    });
    const hook = await mountQueryHook(function useWebMarkReadEffect() {
      const sandboxId = 's';
      const conversationId = 'c';
      const latestMessageId = '01HV0000000000000000000001';
      const marker = `${conversationId}:${latestMessageId}`;
      const visible = mocks.active;
      const markRead = useMarkConversationRead(client);
      const { mutate } = markRead;
      const stateRef = useRef(createMarkReadState());
      const retryStateRef = useRef(createMarkReadRetryState());
      const currentMarkerRef = useRef(marker);
      const visibleRef = useRef(visible);
      const retryRef = useRef<() => void>(() => undefined);
      currentMarkerRef.current = marker;
      visibleRef.current = visible;
      // Match MessageArea's mutate -> callback -> effect dependency chain.
      const markCurrentConversationRead = useCallback(() => {
        const state = stateRef.current;
        if (!shouldStartMarkReadAttempt(state, marker)) {
          return;
        }
        startMarkReadAttempt(state, marker);
        mutate(
          { sandboxId, conversationId, lastSeenMessageId: latestMessageId },
          {
            onSuccess: () => {
              succeedMarkReadAttempt(state, marker);
              clearMarkReadRetry(retryStateRef.current);
            },
            onSettled: () => {
              finishMarkReadAttempt(state, marker);
              if (state.lastSucceededMarker !== marker) {
                scheduleMarkReadRetry(retryStateRef.current, {
                  marker,
                  currentMarker: () => currentMarkerRef.current,
                  isActive: () => visibleRef.current,
                  lastSucceededMarker: () => stateRef.current.lastSucceededMarker,
                  retry: () => {
                    retryRef.current();
                  },
                });
              }
            },
          }
        );
      }, [conversationId, latestMessageId, marker, mutate, sandboxId]);
      retryRef.current = markCurrentConversationRead;
      useEffect(() => {
        if (visible) {
          markCurrentConversationRead();
        }
      }, [markCurrentConversationRead, visible]);
      useEffect(() => {
        const retryState = retryStateRef.current;
        return () => {
          clearMarkReadRetry(retryState);
        };
      }, []);
      return markRead;
    });
    const initial = hook.current;
    await act(async () => {
      firstResponse.resolve(Response.json({ error: 'unavailable' }, { status: 500 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestTimes).toEqual([0]);
    expect(hook.current.status).toBe('error');
    await hook.rerender();
    expect(hook.current.mutate).toBe(initial.mutate);
    expect(hook.current.mutateAsync).toBe(initial.mutateAsync);
    expect(requestTimes).toEqual([0]);

    for (const [elapsed, expected] of [
      [249, [0]],
      [1, [0, 250]],
      [499, [0, 250]],
      [1, [0, 250, 750]],
      [749, [0, 250, 750]],
      [1, [0, 250, 750, 1500]],
      [60_000, [0, 250, 750, 1500]],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- observe each deadline before advancing to the next retry
      await act(async () => {
        await vi.advanceTimersByTimeAsync(elapsed);
      });
      expect(requestTimes).toEqual(expected);
    }
    await hook.rerender();
    expect(requestTimes).toEqual([0, 250, 750, 1500]);
    expect(hook.current.status).toBe('error');
  });

  it.each([
    ['mutate', 200],
    ['mutateAsync', 200],
    ['mutate', 500],
    ['mutateAsync', 500],
  ] as const)('captures current callbacks once for %s with status %s', async (method, status) => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const finished = Promise.withResolvers<undefined>();
    const receipts: string[] = [];
    const requests: string[] = [];
    queryClient = new QueryClient({
      mutationCache: new MutationCache({
        onMutate: async () => {
          entered.resolve(undefined);
          await release.promise;
        },
      }),
      defaultOptions: { mutations: { retry: false } },
    });
    const client = legacyClient(async input => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return Response.json({}, { status });
    });
    let revision = 'mounted';
    const hook = await mountQueryHook(function useCallbackProbe() {
      const label = revision;
      return useKiloChatMutation(client, {
        mutationFn: async (conversationId: string, operation) =>
          client.sendTyping(`${label}-${conversationId}`, operation),
        onMutate: conversationId => {
          receipts.push(`${label}:mutate`);
          return `${label}-${conversationId}`;
        },
        onSuccess: (_data, _variables, context) => {
          receipts.push(`${label}:success:${context ?? 'absent'}`);
        },
        onError: (_error, _variables, context) => {
          receipts.push(`${label}:error:${context ?? 'absent'}`);
        },
        onSettled: () => {
          receipts.push(`${label}:settled`);
        },
      });
    });
    const initial = hook.current;
    revision = 'invoked';
    await hook.rerender();
    expect(hook.current.mutate).toBe(initial.mutate);
    expect(hook.current.mutateAsync).toBe(initial.mutateAsync);
    const callbacks = {
      onSuccess: () => {
        receipts.push('call:success');
      },
      onError: () => {
        receipts.push('call:error');
      },
      onSettled: () => {
        receipts.push('call:settled');
        finished.resolve(undefined);
      },
    };
    const settlement = Promise.withResolvers<PromiseSettledResult<void>[]>();
    await act(async () => {
      if (method === 'mutateAsync') {
        settlement.resolve(Promise.allSettled([initial.mutateAsync('c', callbacks)]));
      } else {
        initial.mutate('c', callbacks);
        settlement.resolve([]);
      }
      await entered.promise;
    });
    revision = 'waiting';
    await hook.rerender();
    await act(async () => {
      release.resolve(undefined);
      await finished.promise;
      await settlement.promise;
      await vi.advanceTimersByTimeAsync(0);
    });
    const outcome = status === 200 ? 'success' : 'error';
    expect(requests).toEqual(['https://chat.test/v1/conversations/invoked-c/typing']);
    expect(receipts).toEqual([
      'invoked:mutate',
      `invoked:${outcome}:invoked-c`,
      'invoked:settled',
      `call:${outcome}`,
      'call:settled',
    ]);
    expect(hook.current.status).toBe(outcome);
    expect(hook.current.mutate).toBe(initial.mutate);
    expect(hook.current.mutateAsync).toBe(initial.mutateAsync);
    if (method === 'mutateAsync') {
      const results = await settlement.promise;
      expect(results.map(result => result.status)).toEqual([
        status === 200 ? 'fulfilled' : 'rejected',
      ]);
    }
  });

  it.each(['before dispatch', 'during request'] as const)(
    'does not redirect an accepted operation when the client changes %s',
    async checkpoint => {
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const requests: string[] = [];
      const receipts: string[] = [];
      let owner = 'a';
      queryClient = new QueryClient({
        mutationCache: new MutationCache({
          onMutate: async () => {
            if (checkpoint === 'before dispatch') {
              entered.resolve(undefined);
              await release.promise;
            }
          },
        }),
        defaultOptions: { mutations: { retry: false } },
      });
      function clientFor(userId: string) {
        return new KiloChatClient({
          eventService: new EventService.EventServiceClient({
            url: 'https://events.test',
            getToken: async () => userId,
          }),
          baseUrl: 'https://chat.test',
          getToken: async () => userId,
          canPublish: () => owner === userId,
          fetch: async () => {
            requests.push(userId);
            if (userId === 'a') {
              entered.resolve(undefined);
              await release.promise;
            }
            return Response.json({});
          },
        });
      }
      let client = clientFor('a');
      const replacement = clientFor('b');
      const hook = await mountQueryHook(function useOwnerProbe() {
        const capturedClient = client;
        const capturedOwner = owner;
        return useKiloChatMutation(capturedClient, {
          mutationFn: async (conversationId: string, operation) =>
            capturedClient.sendTyping(conversationId, operation),
          onSuccess: () => {
            receipts.push(`${capturedOwner}:success`);
          },
          onError: () => {
            receipts.push(`${capturedOwner}:error`);
          },
          onSettled: () => {
            receipts.push(`${capturedOwner}:settled`);
          },
        });
      });
      const initial = hook.current;
      const settlement = Promise.withResolvers<PromiseSettledResult<void>[]>();
      await act(async () => {
        settlement.resolve(
          Promise.allSettled([
            initial.mutateAsync('c', {
              onSettled: () => {
                receipts.push('a:call:settled');
              },
            }),
          ])
        );
        await entered.promise;
      });
      owner = 'b';
      client = replacement;
      await hook.rerender();
      expect(hook.current.mutate).not.toBe(initial.mutate);
      expect(hook.current.mutateAsync).not.toBe(initial.mutateAsync);
      await act(async () => {
        release.resolve(undefined);
        await settlement.promise;
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(await settlement.promise).toEqual([
        { status: 'rejected', reason: new Error('Kilo Chat owner is no longer active') },
      ]);
      expect(requests).toEqual(checkpoint === 'during request' ? ['a'] : []);
      expect(receipts).toEqual([]);
      await act(async () => {
        await hook.current.mutateAsync('new');
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(requests.at(-1)).toBe('b');
      expect(receipts).toEqual(['b:success', 'b:settled']);
    }
  );
});
