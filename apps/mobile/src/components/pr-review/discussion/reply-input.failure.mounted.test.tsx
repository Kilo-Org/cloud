// Mounted coverage for the thread reply surface's inline failures: the empty
// validation, the worded rejections, the offline gate and the reconnect
// retirement, all published through the shared surface-feedback store.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { ReplyInput } from './reply-input';
import {
  failureCopy,
  hasReconnectNotice,
  mount,
  pressReplyAndSettle,
  replyEnabled,
  typeBody,
  unmountAll,
} from './reply-input.test-helpers';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';

type ReplyMutation = ReturnType<typeof useReplyToCommentMutation>;

// The Expo modules below read the build-time `__DEV__` global at import time
// and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { gate, connectivity } = vi.hoisted(() => ({
  gate: { status: vi.fn<() => Promise<{ accepted: boolean; currentVersion: string }>>() },
  connectivity: { value: 'online' },
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
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    moderation: {
      getTermsStatus: { query: () => gate.status() },
      acceptTerms: { mutate: vi.fn() },
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
  connectivity.value = 'online';
  gate.status.mockReset();
  gate.status.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
});

afterEach(() => {
  unmountAll();
});

describe('ReplyInput failure copy', () => {
  it('words an empty reply with the family validation copy, not the field label', async () => {
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(vi.fn()) })
    );
    await pressReplyAndSettle(renderer);

    expect(failureCopy(renderer)).toBe('Comment body cannot be empty.');
    expect(replyEnabled(renderer)).toBe(false);
  });

  it('renders the reply surface copy for a rejected reply', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockRejectedValue(
      Object.assign(new Error('stale'), { data: { code: 'BAD_REQUEST' } })
    );
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(failureCopy(renderer)).toBe("This reply can't be posted. The thread may have changed.");
    expect(replyEnabled(renderer)).toBe(false);
  });

  it('words a refused provider reply after the merge-request noun', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockRejectedValue(
      Object.assign(new Error('403 Forbidden'), { data: { code: 'FORBIDDEN' } })
    );
    const renderer = await mount(
      createElement(ReplyInput, {
        ...baseProps,
        reply: makeReply(mutateAsync),
        provider: { ref: GITLAB_REF, threadId: 'D-77', commentNodeId: '9001' },
      })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(failureCopy(renderer)).toBe("You don't have permission to reply to this merge request.");
  });

  it('never shows the raw provider text for a generic failure', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockRejectedValue(new Error('You do not have access to this repository.'));
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(failureCopy(renderer)).toBe('Could not reply.');
    expect(replyEnabled(renderer)).toBe(true);
  });

  it('fails a submit while confirmed offline at once, keeping Reply live', async () => {
    connectivity.value = 'offline';
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockResolvedValue({});
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(failureCopy(renderer)).toBe('Could not reply.');
    expect(replyEnabled(renderer)).toBe(true);
  });

  it('retires a reconnect failure on the next keystroke', async () => {
    const mutateAsync = vi.fn<() => Promise<unknown>>();
    mutateAsync.mockRejectedValue(
      Object.assign(new Error('GitHub connection expired'), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );
    const renderer = await mount(
      createElement(ReplyInput, { ...baseProps, reply: makeReply(mutateAsync) })
    );
    typeBody(renderer, 'hello');
    await pressReplyAndSettle(renderer);
    expect(hasReconnectNotice(renderer)).toBe(true);

    typeBody(renderer, 'hello!');

    expect(hasReconnectNotice(renderer)).toBe(false);
    expect(replyEnabled(renderer)).toBe(true);
  });
});
