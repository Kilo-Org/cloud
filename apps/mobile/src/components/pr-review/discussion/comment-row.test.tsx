/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommentRow, moderationFailure } from './comment-row';
import { type ReviewComment } from '@/lib/pr-review/discussion/review-discussion-types';

// ── Fixture ──────────────────────────────────────────────────────────

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  const comment: ReviewComment = {
    commentId: 1,
    nodeId: 'C1',
    author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
    bodyMarkdown: 'hello',
    createdAt: '2024-01-01T00:00:00Z',
    reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }],
    ...overrides,
  };
  return comment;
}

// ── Mocks ────────────────────────────────────────────────────────────

type AlertButton = { text?: string; onPress?: () => void };
type MutationOptions = {
  onSuccess?: (result: unknown, input?: unknown) => void;
  onError?: (error: unknown, variables?: unknown) => void;
};

const { alertCalls, showActionSheetMock, mutateFns, capturedOptions } = vi.hoisted(() => ({
  alertCalls: [] as { title: string; message: string; buttons: AlertButton[] }[],
  showActionSheetMock: vi.fn(),
  mutateFns: [] as ReturnType<typeof vi.fn>[],
  capturedOptions: [] as MutationOptions[],
}));

vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, message: string, buttons: AlertButton[]) => {
      alertCalls.push({ title, message, buttons });
    },
  },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: showActionSheetMock }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: MutationOptions) => {
    capturedOptions.push(options);
    const mutate = vi.fn();
    mutateFns.push(mutate);
    return { mutate, mutateAsync: vi.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/ui/icons', () => ({ MoreHorizontal: 'MoreHorizontal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/discussion/reactions-row', () => ({
  ReactionsRow: 'ReactionsRow',
}));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: toastSuccess, error: toastError },
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      listHiddenUsers: { queryKey: () => ['moderation', 'listHiddenUsers'] },
      reportContent: { mutationOptions: (opts: MutationOptions) => opts },
      reportUser: { mutationOptions: (opts: MutationOptions) => opts },
      blockUser: { mutationOptions: (opts: MutationOptions) => opts },
      muteUser: { mutationOptions: (opts: MutationOptions) => opts },
    },
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseTimestamp: () => new Date('2024-01-01T00:00:00Z'),
  timeAgo: () => '2d ago',
}));

// ── Helpers ──────────────────────────────────────────────────────────

async function render(comment: ReviewComment): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(
      createElement(CommentRow, {
        comment,
        onToggleReaction: vi.fn<() => void>(),
        viewerLogin: 'bob',
      })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function openOverflow(renderer: TestRenderer.ReactTestRenderer): void {
  const trigger = renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      (node.props as Record<string, unknown>).accessibilityLabel === 'Comment actions'
  );
  act(() => {
    (trigger.props.onPress as () => void)();
  });
}

function lastSheetCall(): unknown[] {
  const call = showActionSheetMock.mock.calls.at(-1);
  if (!call) {
    throw new Error('No action sheet was shown');
  }
  return call;
}

function selectOverflowAction(index: number): void {
  const callback = lastSheetCall()[1] as ((selected?: number) => void) | undefined;
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- drives the captured action-sheet handler
  callback?.(index);
}

function overflowOptions(): string[] {
  return (lastSheetCall()[0] as { options: string[] }).options;
}

function pressAlertButton(text: string): void {
  const call = alertCalls.at(-1);
  const button = call?.buttons.find(b => b.text === text);
  if (!button) {
    throw new Error(`Alert button "${text}" not found`);
  }
  button.onPress?.();
}

function optionsAt(index: number): MutationOptions {
  const options = capturedOptions[index];
  if (!options) {
    throw new Error(`No mutation options captured at index ${index}`);
  }
  return options;
}

function terminalError(): Error {
  const error = new Error('cannot_target_self');
  Object.assign(error, { data: { code: 'BAD_REQUEST' } });
  return error;
}

describe('moderationFailure (pure classification)', () => {
  it('classifies network and 5xx errors as retryable with action-specific copy', () => {
    expect(moderationFailure('block', new Error('Network request failed'))).toEqual({
      kind: 'retryable',
      message: "Couldn't block this user. Check your connection and try again.",
    });
    const fiveHundred = new Error('boom');
    Object.assign(fiveHundred, { data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(moderationFailure('mute', fiveHundred)).toEqual({
      kind: 'retryable',
      message: "Couldn't mute this user. Check your connection and try again.",
    });
  });

  it('classifies terminal codes as terminal with action-specific copy', () => {
    expect(moderationFailure('report-content', terminalError())).toEqual({
      kind: 'terminal',
      message: "This comment can't be reported.",
    });
    const forbidden = new Error('nope');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });
    expect(moderationFailure('report-user', forbidden)).toEqual({
      kind: 'terminal',
      message: "This user can't be reported.",
    });
  });

  it('distinguishes each action with its own retryable message', () => {
    const error = new Error('Network request failed');
    expect(moderationFailure('report-content', error).message).toContain('comment');
    expect(moderationFailure('report-user', error).message).toContain('user');
    expect(moderationFailure('mute', error).message).toContain('mute');
    expect(moderationFailure('block', error).message).toContain('block');
  });
});

describe('CommentRow overflow actions', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    showActionSheetMock.mockClear();
    mutateFns.length = 0;
    capturedOptions.length = 0;
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy: report content success toasts the receipt', async () => {
    const renderer = await render(makeComment());
    openOverflow(renderer);
    selectOverflowAction(0);

    expect(mutateFns[0]).toHaveBeenCalledTimes(1);
    optionsAt(0).onSuccess?.({ receiptId: 'r1' });
    expect(toastSuccess).toHaveBeenCalledWith('Report submitted. Receipt r1');

    renderer.unmount();
  });

  it('retryable: a transient mute failure shows a Retry CTA that retries the same action', async () => {
    const renderer = await render(makeComment());
    openOverflow(renderer);
    // Mute is the third option (index 2) → muteUser (mutateFns[3]).
    selectOverflowAction(2);

    expect(mutateFns[3]).toHaveBeenCalledTimes(1);
    optionsAt(3).onError?.(new Error('Network request failed'), { githubLogin: 'alice' });

    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]?.message).toBe(
      "Couldn't mute this user. Check your connection and try again."
    );
    pressAlertButton('Retry');

    expect(mutateFns[3]).toHaveBeenCalledTimes(2);
    expect(mutateFns[3]).toHaveBeenLastCalledWith({ githubLogin: 'alice' });

    renderer.unmount();
  });

  it('non-retryable: a terminal block failure toasts once with no Retry CTA', async () => {
    const renderer = await render(makeComment());
    openOverflow(renderer);
    // Block is the fourth option (index 3) → blockUser (mutateFns[2]).
    selectOverflowAction(3);

    expect(mutateFns[2]).toHaveBeenCalledTimes(1);
    optionsAt(2).onError?.(terminalError(), { githubLogin: 'alice' });

    expect(toastError).toHaveBeenCalledWith("This user can't be blocked.");
    expect(alertCalls).toHaveLength(0);

    renderer.unmount();
  });

  it('empty: a deleted author (null) hides the user actions from the overflow menu', async () => {
    const renderer = await render(makeComment({ author: null }));
    openOverflow(renderer);

    expect(overflowOptions()).toEqual(['Report content', 'Cancel']);

    renderer.unmount();
  });
});
