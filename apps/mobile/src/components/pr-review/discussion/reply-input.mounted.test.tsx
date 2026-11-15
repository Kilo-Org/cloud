// Mounted coverage for the thread reply surface: the draft clear rules, the
// provider seam vars, and the inline failures the surface publishes through
// the shared surface-feedback store.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act } from '@/test/renderer';

import { ReplyInput } from './reply-input';
import {
  field,
  mount,
  pressReply,
  pressReplyAndSettle,
  replyEnabled,
  typeBody,
  unmountAll,
} from './reply-input.test-helpers';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import { providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import { clearDraft, clearDraftIfStill } from '@/lib/persist/drafts';

type ReplyMutation = ReturnType<typeof useReplyToCommentMutation>;

// The Expo modules below read the build-time `__DEV__` global at import time
// and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { draftLoad, gate, connectivity, termsStatus } = vi.hoisted(() => ({
  draftLoad: { value: { settled: true, value: null as string | null } },
  gate: { status: vi.fn<() => Promise<{ accepted: boolean; currentVersion: string }>>() },
  connectivity: { value: 'online' },
  termsStatus: { accept: vi.fn<() => Promise<unknown>>() },
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  connectionRefusesWrites: () => connectivity.value === 'offline',
  getCommittedConnectivityStatus: () => connectivity.value,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));

vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  clearDraftIfStill: vi.fn(),
  prReplyDraftKey: vi.fn(() => 'pr-reply:key'),
}));

vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => draftLoad.value,
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    moderation: {
      getTermsStatus: { query: () => gate.status() },
      acceptTerms: { mutate: () => termsStatus.accept() },
    },
  },
}));

const GITLAB_REF = { platform: 'gitlab' as const, projectPath: 'octocat/hello', mrIid: 1 };

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 7,
};

function makeReply(mutateAsync: (input: unknown) => Promise<unknown>): ReplyMutation {
  return { mutateAsync } as unknown as ReplyMutation;
}

beforeEach(() => {
  draftLoad.value = { settled: true, value: null };
  connectivity.value = 'online';
  gate.status.mockReset();
  gate.status.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
  termsStatus.accept.mockReset();
  vi.mocked(clearDraft).mockReset();
  vi.mocked(clearDraftIfStill).mockReset();
});

afterEach(() => {
  unmountAll();
});

describe('ReplyInput submit', () => {
  it('clears the reply draft on a successful reply', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockResolvedValue({});
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 7,
      body: 'hello',
    });
    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-reply:key');
  });

  it('keeps the draft when the reply is rejected', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockRejectedValue(
      Object.assign(new Error('stale'), { data: { code: 'BAD_REQUEST' } })
    );
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(clearDraft).not.toHaveBeenCalled();
  });

  it('does not submit while the Terms gate is dismissed', async () => {
    gate.status.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockResolvedValue({});
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it('issues one reply for two taps during the Terms status round-trip', async () => {
    const roundTrip = Promise.withResolvers<{ accepted: boolean; currentVersion: string }>();
    gate.status.mockReturnValueOnce(roundTrip.promise);
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockResolvedValue({});
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');

    act(() => {
      pressReply(renderer);
    });
    act(() => {
      pressReply(renderer);
    });
    expect(field(renderer).props.editable).toBe(false);

    await act(async () => {
      roundTrip.resolve({ accepted: true, currentVersion: 'v1' });
      await Promise.resolve();
    });

    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('posts the provider seam vars on a provider thread', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockResolvedValue({});
    const renderer = await mount(
      createElement(ReplyInput, {
        ...baseProps,
        reply: makeReply(mutateAsync),
        provider: { ref: GITLAB_REF, threadId: 'D-77', commentNodeId: '9001' },
      })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(mutateAsync).toHaveBeenCalledWith({
      threadId: 'D-77',
      commentNodeId: '9001',
      body: 'hello',
    });
    expect(clearDraft).toHaveBeenCalledWith('u1', `pr-reply:key@${providerPrRefKey(GITLAB_REF)}`);
  });

  it('posts nothing when the thread unmounts during the Terms read', async () => {
    const roundTrip = Promise.withResolvers<{ accepted: boolean; currentVersion: string }>();
    gate.status.mockReturnValueOnce(roundTrip.promise);
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockResolvedValue({});
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');

    act(() => {
      pressReply(renderer);
    });
    unmountAll();

    await act(async () => {
      roundTrip.resolve({ accepted: true, currentVersion: 'v1' });
      await Promise.resolve();
    });

    // The gate resolved for a token the unmount invalidated.
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('clears the posted body when a deferred success lands with no replacement draft', async () => {
    const deferred = Promise.withResolvers<unknown>();
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockReturnValue(deferred.promise);
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    act(() => {
      pressReply(renderer);
    });

    // Let the Terms gate resolve and the write start before the unmount.
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    // The user left without typing again: the durable draft still holds the
    // body that was just posted, so reopening must not re-seed it.
    unmountAll();
    await act(async () => {
      deferred.resolve({});
      await Promise.resolve();
    });

    expect(clearDraftIfStill).toHaveBeenCalledWith('u1', 'pr-reply:key', JSON.stringify('hello'));
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it('keeps the replacement draft when a deferred reply resolves after unmount', async () => {
    const deferred = Promise.withResolvers<unknown>();
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockReturnValue(deferred.promise);
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    act(() => {
      pressReply(renderer);
    });

    // The user leaves the thread and reopens it; the late success belongs to a
    // component that no longer owns the draft slot.
    unmountAll();
    const reopened = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(vi.fn()) })
    );
    typeBody(reopened, 'replacement reply');

    await act(async () => {
      deferred.resolve({});
      await Promise.resolve();
    });

    expect(clearDraft).not.toHaveBeenCalled();
  });
});

describe('ReplyInput draft seeding', () => {
  it('seeds the field from the settled draft value', async () => {
    draftLoad.value = { settled: true, value: 'saved reply' };
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(vi.fn()) })
    );
    expect(field(renderer).props.defaultValue).toBe('saved reply');
  });

  it('seeds an empty field when the settled draft has no value', async () => {
    draftLoad.value = { settled: true, value: null };
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(vi.fn()) })
    );
    expect(field(renderer).props.defaultValue).toBe('');
  });

  it('hides the field and disables Reply until the draft settles', async () => {
    draftLoad.value = { settled: false, value: null };
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(vi.fn()) })
    );
    expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
    expect(replyEnabled(renderer)).toBe(false);
  });
});
