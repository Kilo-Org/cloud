// Mounted coverage for the thread reply surface: the draft clear rules, the
// provider seam vars, and the inline failures the surface publishes through
// the shared surface-feedback store.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act } from '@/test/renderer';

import { ReplyInput } from './reply-input';
import {
  failureCopy,
  field,
  hasReconnectNotice,
  mount,
  pressReply,
  pressReplyAndSettle,
  replyEnabled,
  typeBody,
  unmountAll,
} from './reply-input.test-helpers';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import { providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import { clearDraft } from '@/lib/persist/drafts';

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
  getCommittedConnectivityStatus: () => connectivity.value,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));

vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
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

describe('ReplyInput failure copy', () => {
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
