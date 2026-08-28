/* eslint-disable typescript-eslint/no-deprecated -- this collected suite mounts both mobile mark-read queues without a DOM */
/* eslint-disable require-await, typescript-eslint/require-await -- async doubles and act callbacks preserve native promise contracts */
/* eslint-disable init-declarations -- beforeEach and act establish the owner and mounted fixtures before use */
/* eslint-disable max-lines -- both mark-read queues and mobile admission races share this mounted fixture */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  MutationCache,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { KiloChatClient, type Message } from '@kilocode/kilo-chat';
import { EventServiceClient } from '@kilocode/event-service';
import { useSendMessage } from '@kilocode/kilo-chat-hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  initializeLocalAccess,
  lockLocalAccess,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import {
  assertMobileActionAdmission,
  captureMobileActionAdmission,
  isTransportOwner,
} from '@/lib/local-access-transport';
import { useMarkRead } from './hooks/use-mark-read';
import { useConversationMarkRead } from './hooks/use-conversation-mark-read';
import { clearSubmittedMessageInputDraft, submitMessageInputDraft } from './message-input-state';
import { mobilePerformUpload } from './mobile-perform-upload';

// Queue inventory: useMarkRead (outer mutation), useMarkConversationRead
// (shared mutation), and useConversationMarkRead (delayed retry). Each keeps
// the operation captured before its first wait.
const native = vi.hoisted(() => ({ badges: [] as number[] }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn<() => void>() }));
vi.mock('expo-notifications', () => ({
  setBadgeCountAsync: async (count: number) => {
    native.badges.push(count);
    return true;
  },
}));
vi.mock('./hooks/use-current-user-id', () => ({
  useCurrentUserId: () => getAuthenticatedOwner().userId,
}));
vi.mock('./hooks/use-app-active-and-focused', () => ({ useAppActiveAndFocused: () => true }));

const messageId = '01HV0000000000000000000001';
const conversationId = '01HV0000000000000000000000';
const message: Message = {
  id: messageId,
  senderId: 'bot:assistant',
  content: [],
  inReplyToMessageId: null,
  replyTo: null,
  updatedAt: null,
  clientUpdatedAt: null,
  deleted: false,
  deliveryFailed: false,
  reactions: [],
};
const success = {
  ok: true,
  applied: true,
  lastReadAt: 42,
  badgeClear: { badgeBucket: 'bucket', badgeCount: 0 },
};
let renderer: TestRenderer.ReactTestRenderer | undefined;
let disposeAccess: (() => void) | undefined;
let queryClient: QueryClient;
let client: KiloChatClient;
let requests: string[];
let respond: () => Promise<Response>;
let markRead: ReturnType<typeof useMarkRead> | undefined;
let send: ReturnType<typeof useSendMessage> | undefined;
function ManualProbe() {
  markRead = useMarkRead(client);
  send = useSendMessage(client, conversationId, getAuthenticatedOwner().userId);
  return null;
}
function AutomaticProbe() {
  useConversationMarkRead({
    client,
    conversationId,
    currentUserId: getAuthenticatedOwner().userId,
    hasInitialMessages: true,
    messages: [message],
    sandboxId: 's',
  });
  return null;
}
async function selectOwner(userId: string) {
  bumpAuthEpoch();
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), userId);
  await setLocalAccessOwner(userId, currentAuthEpoch());
  setLocalAccessContextReady(true);
  await requestLocalAccess('unlock');
}
async function mount(automatic = false) {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(automatic ? AutomaticProbe : ManualProbe)
      )
    );
  });
}
async function mark() {
  if (!markRead) {
    throw new Error('mark-read hook not mounted');
  }
  return markRead('s', conversationId, messageId);
}

beforeEach(async () => {
  requests = [];
  native.badges = [];
  markRead = undefined;
  send = undefined;
  onlineManager.setOnline(true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  disposeAccess = initializeLocalAccess({
    storage: {
      read: async () => ({ status: 'present', enabled: true }),
      write: async () => 'committed',
    },
    authenticate: async () => ({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => vi.fn<() => void>() },
  });
  await selectOwner('a');
  const owner = getAuthenticatedOwner();
  respond = async () => Response.json(success);
  client = new KiloChatClient({
    eventService: new EventServiceClient({ url: 'https://events.test', getToken: async () => 'a' }),
    baseUrl: 'https://chat.test',
    getToken: async () => 'a',
    fetch: async input => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return respond();
    },
    canPublish: () => isTransportOwner(owner),
    captureOperationAdmission: () => {
      const admission = captureMobileActionAdmission(owner, null);
      return () => {
        assertMobileActionAdmission(admission);
      };
    },
  });
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(['badges', 'a'], [{ badgeBucket: 'bucket', badgeCount: 2 }]);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  client.dispose();
  queryClient.clear();
  disposeAccess?.();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mobile mark-read queue inventory', () => {
  it.each(['lock/unlock', 'account replacement'] as const)(
    'keeps outer admission through an offline pause and %s',
    async change => {
      onlineManager.setOnline(false);
      await mount();
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = mark();
      });
      const rejected = expect(pending).rejects.toThrow();
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some(mutation => mutation.state.isPaused)
      ).toBe(true);
      await act(async () => {
        if (change === 'lock/unlock') {
          lockLocalAccess();
          await requestLocalAccess('unlock');
        } else {
          await selectOwner('b');
        }
        onlineManager.setOnline(true);
        await rejected;
      });
      expect(requests).toEqual([]);
      expect(queryClient.getQueryData(['badges', 'a'])).toEqual([
        { badgeBucket: 'bucket', badgeCount: 2 },
      ]);
      expect(native.badges).toEqual([]);
    }
  );

  it('keeps outer admission through its global onMutate wait', async () => {
    const waiting = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    queryClient = new QueryClient({
      mutationCache: new MutationCache({
        onMutate: async () => {
          entered.resolve(undefined);
          await waiting.promise;
        },
      }),
    });
    await mount();
    const pending = mark();
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    lockLocalAccess();
    await requestLocalAccess('unlock');
    await act(async () => {
      waiting.resolve(undefined);
      await rejected;
    });
    expect(requests).toEqual([]);
    expect(native.badges).toEqual([]);
  });

  it('retries a network failure under the original operation when access remains valid', async () => {
    vi.useFakeTimers();
    respond = async () =>
      requests.length === 1
        ? Response.json({ error: 'offline' }, { status: 503 })
        : Response.json(success);
    await mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requests).toHaveLength(2);
    expect(native.badges).toEqual([0]);
    expect(queryClient.getQueryData(['badges', 'a'])).toEqual([]);
  });

  it.each(['lock/unlock', 'account replacement'] as const)(
    'cancels the delayed retry after %s without recapturing admission',
    async change => {
      vi.useFakeTimers();
      respond = async () => Response.json({ error: 'offline' }, { status: 503 });
      await mount(true);
      expect(requests).toHaveLength(1);
      await act(async () => {
        if (change === 'lock/unlock') {
          lockLocalAccess();
          await requestLocalAccess('unlock');
        } else {
          await selectOwner('b');
        }
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(requests).toHaveLength(1);
      expect(native.badges).toEqual([]);
    }
  );

  it('does not publish an accepted A badge response into B or update the native badge', async () => {
    const response = Promise.withResolvers<Response>();
    respond = async () => response.promise;
    await mount();
    const pending = mark();
    const rejected = expect(pending).rejects.toThrow('owner is no longer active');
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    await act(async () => {
      await selectOwner('b');
      queryClient.clear();
      queryClient.setQueryData(['badges', 'b'], [{ badgeBucket: 'bucket', badgeCount: 7 }]);
      response.resolve(Response.json(success));
      await rejected;
    });
    expect(queryClient.getQueryData(['badges', 'b'])).toEqual([
      { badgeBucket: 'bucket', badgeCount: 7 },
    ]);
    expect(queryClient.getQueryData(['badges', 'a'])).toBeUndefined();
    expect(native.badges).toEqual([]);
  });

  it('does not mark locked incoming content as read', async () => {
    lockLocalAccess();
    await mount(true);
    expect(requests).toEqual([]);
    expect(native.badges).toEqual([]);
  });
});

describe('mobile draft and upload admission', () => {
  it('retains text and attachment chips when a shared send wait crosses lock/unlock', async () => {
    const waiting = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    vi.spyOn(queryClient, 'cancelQueries').mockImplementation(async () => {
      entered.resolve(undefined);
      await waiting.promise;
    });
    await mount();
    const valueRef = { current: 'keep this text' };
    let chips = ['photo'];
    const submission = submitMessageInputDraft({
      valueRef,
      onSend: vi.fn<() => void>(),
      onSendContentBlocks: async (content, _reply, controls) => {
        if (!send) {
          throw new Error('send hook not mounted');
        }
        await send.mutateAsync({ conversationId, clientId: '01HV0000000000000000000002', content });
        clearSubmittedMessageInputDraft({
          controls,
          submittedAttachmentTempIds: ['photo'],
          clearSubmittedFiles: () => {
            chips = [];
          },
        });
      },
      clearInput: vi.fn<() => void>(),
      setCanSend: vi.fn<() => void>(),
      readyAttachmentBlocks: [
        {
          type: 'attachment',
          attachmentId: messageId,
          filename: 'a.png',
          mimeType: 'image/png',
          size: 4,
        },
      ],
    });
    if (!submission) {
      throw new Error('draft did not submit');
    }
    const rejected = expect(submission.completion).rejects.toThrow();
    await entered.promise;
    lockLocalAccess();
    await requestLocalAccess('unlock');
    await act(async () => {
      waiting.resolve(undefined);
      await rejected;
    });
    expect(valueRef.current).toBe('keep this text');
    expect(chips).toEqual(['photo']);
    expect(requests).toEqual([]);
  });

  it('requires mobile upload admission and checks it after XHR preparation', async () => {
    const sent: Blob[] = [];
    class Upload {
      upload = { addEventListener: vi.fn<() => void>() };
      open = vi.fn(() => {
        lockLocalAccess();
      });
      setRequestHeader = vi.fn<() => void>();
      addEventListener = vi.fn<() => void>();
      send = vi.fn<(blob: Blob) => void>(blob => {
        sent.push(blob);
      });
    }
    vi.stubGlobal('XMLHttpRequest', Upload);
    const options = { signal: new AbortController().signal, onProgress: vi.fn<() => void>() };
    await expect(
      mobilePerformUpload(new Blob(['private']), 'https://upload.test', {}, options)
    ).rejects.toMatchObject({ code: 'LOCAL_ACCESS_DENIED' });
    const operation = client.captureOperation();
    await expect(
      mobilePerformUpload(
        new Blob(['private']),
        'https://upload.test',
        {},
        { ...options, operation }
      )
    ).rejects.toMatchObject({ code: 'LOCAL_ACCESS_DENIED' });
    expect(sent).toEqual([]);
  });
});
