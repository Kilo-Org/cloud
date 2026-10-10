/* eslint-disable max-lines -- one suite for the row's moderation overflow, its capability gates, its CTA wiring and the shared-mutation provider (Fix 19) */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommentRow } from './comment-row';
import { CommentModerationProvider, moderationFailure } from './comment-moderation';
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
vi.mock('@/components/pr-review/discussion/pr-comment-fix-with-kilo', () => ({
  PrCommentFixWithKilo: 'PrCommentFixWithKilo',
}));
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

async function render(
  comment: ReviewComment,
  viewerLogin: string | null = 'bob',
  extra: {
    readOnly?: boolean;
    reactionsSupported?: boolean;
    onEditComment?: () => void;
    onDeleteComment?: () => void;
  } = {}
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(
      createElement(
        CommentModerationProvider,
        null,
        createElement(CommentRow, {
          comment,
          owner: 'octocat',
          repo: 'hello',
          number: 7,
          commentKind: 'review',
          onToggleReaction: vi.fn<() => void>(),
          viewerLogin,
          ...extra,
        })
      )
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

/** Mounts `count` rows under ONE provider (Fix 19: the mutations are shared). */
async function renderRows(count: number): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(
      createElement(
        CommentModerationProvider,
        null,
        ...Array.from({ length: count }, (_, index) =>
          createElement(CommentRow, {
            comment: makeComment({ commentId: index + 1, nodeId: `C${index + 1}` }),
            owner: 'octocat',
            repo: 'hello',
            number: 7,
            commentKind: 'review',
            onToggleReaction: vi.fn<() => void>(),
            viewerLogin: 'bob',
          })
        )
      )
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- act() may not assign
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

function disabledButtonIndices(): number[] | undefined {
  return (lastSheetCall()[0] as { disabledButtonIndices?: number[] }).disabledButtonIndices;
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

  it('disables self-target user actions when the login differs only by case', async () => {
    const renderer = await render(
      makeComment({ author: { login: 'Bob', avatarUrl: 'https://example.com/b.png' } }),
      'bob'
    );
    openOverflow(renderer);

    expect(disabledButtonIndices()).toEqual([1, 2, 3]);

    renderer.unmount();
  });
});

// s4: the viewer's own comment gains Edit comment / Delete comment. The
// self-target moderation trio is dropped when those callbacks are wired (a row
// of disabled entries is a dead affordance); a read-only provider row passes
// neither callback and keeps today's menu exactly.
describe('CommentRow own-comment actions (s4)', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    showActionSheetMock.mockClear();
    mutateFns.length = 0;
    capturedOptions.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers Edit comment then Delete comment on the viewer’s own comment and dispatches each once', async () => {
    const onEditComment = vi.fn<() => void>();
    const onDeleteComment = vi.fn<() => void>();
    const renderer = await render(
      makeComment({ author: { login: 'bob', avatarUrl: null } }),
      'bob',
      { onEditComment, onDeleteComment }
    );
    openOverflow(renderer);

    expect(overflowOptions()).toEqual([
      'Edit comment',
      'Delete comment',
      'Report content',
      'Cancel',
    ]);

    // Index 0 is Edit comment; index 1 is Delete comment.
    selectOverflowAction(0);
    expect(onEditComment).toHaveBeenCalledTimes(1);
    expect(onDeleteComment).not.toHaveBeenCalled();

    selectOverflowAction(1);
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
    expect(onEditComment).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('matches the viewer login case-insensitively for the own-comment gate', async () => {
    const onEditComment = vi.fn<() => void>();
    const onDeleteComment = vi.fn<() => void>();
    const renderer = await render(
      makeComment({ author: { login: 'Bob', avatarUrl: null } }),
      'bob',
      { onEditComment, onDeleteComment }
    );
    openOverflow(renderer);

    expect(overflowOptions()).toEqual([
      'Edit comment',
      'Delete comment',
      'Report content',
      'Cancel',
    ]);

    renderer.unmount();
  });

  it('offers no edit and no delete on another author’s comment', async () => {
    const onEditComment = vi.fn<() => void>();
    const onDeleteComment = vi.fn<() => void>();
    const renderer = await render(makeComment(), 'bob', { onEditComment, onDeleteComment });
    openOverflow(renderer);

    expect(overflowOptions()).toEqual(['Report content', 'Report user', 'Mute', 'Block', 'Cancel']);

    // Report content is index 0 here — never a stale own-comment index.
    selectOverflowAction(0);
    expect(onEditComment).not.toHaveBeenCalled();
    expect(onDeleteComment).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('offers no edit and no delete to an anonymous viewer (null login)', async () => {
    const onEditComment = vi.fn<() => void>();
    const onDeleteComment = vi.fn<() => void>();
    const renderer = await render(
      makeComment({ author: { login: 'bob', avatarUrl: null } }),
      null,
      { onEditComment, onDeleteComment }
    );
    openOverflow(renderer);

    expect(overflowOptions()).toEqual(['Report content', 'Report user', 'Mute', 'Block', 'Cancel']);

    selectOverflowAction(0);
    expect(onEditComment).not.toHaveBeenCalled();
    expect(onDeleteComment).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('offers no edit and no delete without callbacks (provider scope), keeping today’s disabled trio', async () => {
    const renderer = await render(
      makeComment({ author: { login: 'bob', avatarUrl: null } }),
      'bob'
    );
    openOverflow(renderer);

    expect(overflowOptions()).toEqual(['Report content', 'Report user', 'Mute', 'Block', 'Cancel']);
    expect(disabledButtonIndices()).toEqual([1, 2, 3]);

    renderer.unmount();
  });

  it('offers no edit and no delete on a deleted-author comment (author null)', async () => {
    const onEditComment = vi.fn<() => void>();
    const onDeleteComment = vi.fn<() => void>();
    const renderer = await render(makeComment({ author: null }), 'bob', {
      onEditComment,
      onDeleteComment,
    });
    openOverflow(renderer);

    expect(overflowOptions()).toEqual(['Report content', 'Cancel']);

    renderer.unmount();
  });
});

// Fix 19: the four moderation `useMutation` hooks used to mount once per row
// (4N observers for N mounted rows). One provider owns them and every row
// shares that set.
describe('CommentModerationProvider sharing (Fix 19)', () => {
  beforeEach(() => {
    mutateFns.length = 0;
    capturedOptions.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mounts four mutations once for a provider holding several rows, not once per row', async () => {
    const renderer = await renderRows(3);

    expect(renderer.root.findAll(node => String(node.type) === 'MarkdownText')).toHaveLength(3);
    expect(mutateFns).toHaveLength(4);
    expect(capturedOptions).toHaveLength(4);

    renderer.unmount();
  });
});

describe('CommentRow reactions capability gate (s6)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // eslint-disable-next-line typescript-eslint/promise-function-async -- thin wrapper around the shared renderer
  function renderWithCapabilities(
    reactionsSupported: boolean
  ): Promise<TestRenderer.ReactTestRenderer> {
    return render(makeComment(), null, { readOnly: true, reactionsSupported });
  }

  it('supported (default): renders the reactions row', async () => {
    const renderer = await renderWithCapabilities(true);
    expect(renderer.root.findAll(node => (node.type as string) === 'ReactionsRow')).toHaveLength(1);
    renderer.unmount();
  });

  it('unsupported: renders no reactions row at all — never an empty or failing one', async () => {
    const renderer = await renderWithCapabilities(false);
    expect(renderer.root.findAll(node => (node.type as string) === 'ReactionsRow')).toHaveLength(0);
    renderer.unmount();
  });
});

describe('CommentRow Fix with Kilo CTA (s2)', () => {
  it('passes the provider triple, the comment id and the kind to the row CTA', async () => {
    const renderer = await render(makeComment({ commentId: 42 }));

    const cta = renderer.root.find(node => String(node.type) === 'PrCommentFixWithKilo');
    expect(cta.props).toMatchObject({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      commentId: 42,
      kind: 'review',
    });
  });
});

describe('CommentRow avatar recycling', () => {
  it('sets recyclingKey to the author avatar URL so a recycled row clears the previous image', async () => {
    const avatarUrl = 'https://example.com/alice.png';
    const renderer = await render(makeComment({ author: { login: 'alice', avatarUrl } }));

    const image = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'Image'
    );
    expect((image.props as Record<string, unknown>).recyclingKey).toBe(avatarUrl);

    renderer.unmount();
  });
});
