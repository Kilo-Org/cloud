/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DiscussionThread } from './discussion-thread';
import { type ReviewThread } from '@/lib/pr-review/discussion/review-discussion-types';

// ── Fixture ──────────────────────────────────────────────────────────

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    threadId: 'T1',
    isResolved: false,
    isOutdated: false,
    subjectType: 'LINE',
    path: 'src/index.ts',
    line: 10,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    diffHunk: null,
    comments: [
      {
        commentId: 1,
        nodeId: 'C1',
        author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
        bodyMarkdown: 'hello',
        createdAt: '2024-01-01T00:00:00Z',
        reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }],
      },
    ],
    ...overrides,
  };
}

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  expanded: false,
  onToggleExpand: vi.fn<() => void>(),
};

// ── Mocks ────────────────────────────────────────────────────────────

const { resolveMutate, unresolveMutate } = vi.hoisted(() => ({
  resolveMutate: vi.fn(),
  unresolveMutate: vi.fn(),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));

vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  CheckCheck: 'CheckCheck',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
}));

vi.mock('@/components/pr-review/discussion/comment-row', () => ({
  CommentRow: 'CommentRow',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ReplyInput: 'ReplyInput',
}));

vi.mock('@/components/pr-review/discussion/thread-diff-snippet', () => ({
  ThreadDiffSnippet: 'ThreadDiffSnippet',
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#6F6A61',
    good: '#22C55E',
    destructive: '#EF4444',
    warn: '#F59E0B',
  }),
}));

vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddReactionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveReactionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useReplyToCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveThreadMutation: () => ({ mutate: resolveMutate, isPending: false }),
  useUnresolveThreadMutation: () => ({ mutate: unresolveMutate, isPending: false }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

async function render(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(element);
  });
  // Runtime safety: act() could theoretically fail without assigning.
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function findNode(
  root: TestRenderer.ReactTestInstance,
  type: string,
  match: (props: Record<string, unknown>) => boolean
): TestRenderer.ReactTestInstance | undefined {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === type &&
      match(node.props as Record<string, unknown>)
  );
}

function findPressableByA11yLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | undefined {
  return findNode(root, 'Pressable', p => p.accessibilityLabel === label);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('DiscussionThread collapsed card', () => {
  it('has a pressable root with button role and collapsed state', async () => {
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, { ...baseProps, thread, expanded: false })
    );
    const node = renderer.root.children[0] as TestRenderer.ReactTestInstance;

    expect(typeof node.type).toBe('string');
    expect(node.type).toBe('Pressable');
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityState).toEqual({ expanded: false });
    expect(node.props.accessibilityLabel).toBe('Discussion thread src/index.ts L10 (RIGHT)');
    expect(node.props.className).toContain('active:opacity-70');

    renderer.unmount();
  });

  it('fires onToggleExpand when the root is pressed', async () => {
    const onToggleExpand = vi.fn<() => void>();
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, {
        ...baseProps,
        thread,
        expanded: false,
        onToggleExpand,
      })
    );
    const rootNode = renderer.root.children[0] as TestRenderer.ReactTestInstance;

    (rootNode.props.onPress as () => void)();
    expect(onToggleExpand).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('has no pressable header label row inside the collapsed root', async () => {
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, { ...baseProps, thread, expanded: false })
    );
    const rootNode = renderer.root.children[0] as TestRenderer.ReactTestInstance;

    // The inner label row is a View, not a Pressable.
    const expandPressables = rootNode.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        ((node.props as Record<string, unknown>).accessibilityLabel === 'Expand thread' ||
          (node.props as Record<string, unknown>).accessibilityLabel === 'Collapse thread')
    );
    expect(expandPressables).toHaveLength(0);

    renderer.unmount();
  });

  it('contains a resolve toggle pressable', async () => {
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, { ...baseProps, thread, expanded: false })
    );

    const resolveButton = findPressableByA11yLabel(renderer.root, 'Resolve thread');
    expect(resolveButton).toBeDefined();

    renderer.unmount();
  });
});

describe('DiscussionThread expanded card', () => {
  it('has a plain View root with the thread a11y label', async () => {
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, { ...baseProps, thread, expanded: true })
    );
    const node = renderer.root.children[0] as TestRenderer.ReactTestInstance;

    expect(typeof node.type).toBe('string');
    expect(node.type).toBe('View');
    expect(node.props.accessibilityLabel).toBe('Discussion thread src/index.ts L10 (RIGHT)');

    renderer.unmount();
  });

  it('has a pressable header label row for collapsing', async () => {
    const onToggleExpand = vi.fn<() => void>();
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, {
        ...baseProps,
        thread,
        expanded: true,
        onToggleExpand,
      })
    );

    const collapseButton = findPressableByA11yLabel(renderer.root, 'Collapse thread');
    if (!collapseButton) {
      throw new Error('Collapse thread button not found');
    }

    (collapseButton.props.onPress as () => void)();
    expect(onToggleExpand).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('renders comments and reply input when expanded', async () => {
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, { ...baseProps, thread, expanded: true })
    );

    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'CommentRow'
      )
    ).toHaveLength(1);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ReplyInput'
      )
    ).toHaveLength(1);

    renderer.unmount();
  });
});

describe('DiscussionThread anchor label', () => {
  it('renders anchor Text single-line with flex-1 class', async () => {
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, { ...baseProps, thread, expanded: false })
    );

    const anchorText = findNode(
      renderer.root,
      'Text',
      p => p.children === 'src/index.ts L10 (RIGHT)'
    );
    expect(anchorText).toBeDefined();
    if (!anchorText) {
      throw new Error('Anchor label Text not found');
    }

    expect(anchorText.props.numberOfLines).toBe(1);
    expect(anchorText.props.className).toContain('flex-1');

    renderer.unmount();
  });
});

describe('DiscussionThread resolve action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls resolveMutate with threadId and never fires expand', async () => {
    const onToggleExpand = vi.fn<() => void>();
    const thread = makeThread();
    const renderer = await render(
      createElement(DiscussionThread, {
        ...baseProps,
        thread,
        expanded: false,
        onToggleExpand,
      })
    );

    const resolveButton = findPressableByA11yLabel(renderer.root, 'Resolve thread');
    if (!resolveButton) {
      throw new Error('Resolve thread button not found');
    }
    (resolveButton.props.onPress as () => void)();

    expect(resolveMutate).toHaveBeenCalledTimes(1);
    expect(resolveMutate).toHaveBeenCalledWith({ threadId: 'T1' });
    expect(unresolveMutate).not.toHaveBeenCalled();
    expect(onToggleExpand).not.toHaveBeenCalled();

    renderer.unmount();
  });
});
