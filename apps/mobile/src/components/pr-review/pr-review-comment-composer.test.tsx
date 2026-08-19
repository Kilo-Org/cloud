// Clear-rule coverage for the comment composer's durable draft. The composer
// clears its draft on three committed outcomes — comment post, add-to-review,
// and a confirmed discard — and keeps it on a dismissed-without-confirmation
// discard. `Alert.alert` is captured so the test can press the Discard /
// Keep editing buttons the discard gate renders.
//
// The composer is mounted by calling it as a plain function (no renderer), so
// the React hook primitives are stubbed, mirroring pr-merge-sheet.test.tsx.

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewCommentComposer } from './pr-review-comment-composer';
import { clearDraft } from '@/lib/persist/drafts';

type AlertButton = { text?: string; style?: string; onPress?: () => void };
type AlertCall = { title: string; message: string; buttons: AlertButton[] };

const { alertCalls, createCommentMocks } = vi.hoisted(() => ({
  alertCalls: [] as AlertCall[],
  createCommentMocks: {
    mutateAsync: vi.fn<() => Promise<unknown>>(),
    isPending: false,
    error: null as Error | null,
  },
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(
      <T,>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]
    ),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    useRef: vi.fn(<T,>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useEffect: vi.fn((effect: React.EffectCallback) => {
      effect();
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
  };
});

vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, message: string, buttons: AlertButton[]) => {
      alertCalls.push({ title, message, buttons });
    },
  },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
  Platform: { OS: 'ios' },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  useFormSheetKeyboardVisible: () => false,
}));

vi.mock('@/components/pr-review/composer-inline-error', () => ({
  ComposerInlineError: 'ComposerInlineError',
  useComposerInlineError: () => ({
    inlineError: null,
    inlineErrorKind: null,
    inlineErrorIsLocal: false,
    setInlineError: vi.fn(),
    setInlineErrorKind: vi.fn(),
    setInlineErrorIsLocal: vi.fn(),
    clearBadRequestOnBodyEdit: vi.fn(),
  }),
}));

vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
  ComposerFooter: 'ComposerFooter',
  composerRangeLabel: (line: number, startLine?: number) =>
    startLine !== undefined && startLine !== line ? `L${startLine}–L${line}` : `L${line}`,
  ContextPreview: 'ContextPreview',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: vi.fn().mockResolvedValue({ kind: 'accepted' as const }),
  TERMS_OUTDATED_COPY: 'outdated',
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));

vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  prCommentDraftKey: vi.fn(() => 'pr-comment:key'),
  prReplyDraftKey: vi.fn(),
  prMergeDraftKey: vi.fn(),
}));

vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({
  useDraftFlushOnBackground: vi.fn(),
}));

vi.mock('@/lib/pr-review/build-suggestion-fence', () => ({
  buildSuggestionFence: () => null,
}));

vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({
  getDiffSelection: () => null,
}));

vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({
    items: [],
    addComment: vi.fn(),
    updateComment: vi.fn(),
    removeComment: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock('@/lib/pr-review/use-pr-review-mutations', () => ({
  useCreateReviewCommentMutation: () => ({
    mutateAsync: createCommentMocks.mutateAsync,
    isPending: createCommentMocks.isPending,
    error: createCommentMocks.error,
  }),
}));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  mode: { kind: 'create', headSha: 'a'.repeat(40) } as const,
  path: 'src/a.ts',
  side: 'RIGHT' as const,
  line: 10,
  title: 'Comment',
  eyebrow: 'octocat/hello#1',
  onDismiss: vi.fn(),
};

function findByType(node: unknown, type: string): React.ReactElement | null {
  if (React.isValidElement(node)) {
    const element = node;
    if (element.type === type) {
      return element;
    }
    const children = (element.props as Record<string, unknown>).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findByType(child, type);
        if (found) {
          return found;
        }
      }
    } else if (children !== undefined && children !== null) {
      const found = findByType(children, type);
      if (found) {
        return found;
      }
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function mountComposer(): React.ReactElement {
  // eslint-disable-next-line new-cap
  return PrReviewCommentComposer(baseProps);
}

function typeBody(element: React.ReactElement, text: string): void {
  const field = findByType(element, 'CommentBodyField');
  if (!field) {
    throw new Error('CommentBodyField not found');
  }
  (field.props as { onChangeText?: (value: string) => void }).onChangeText?.(text);
}

function footerProp(element: React.ReactElement, prop: string): (() => void) | undefined {
  const footer = findByType(element, 'ComposerFooter');
  if (!footer) {
    throw new Error('ComposerFooter not found');
  }
  return (footer.props as Record<string, (() => void) | undefined>)[prop];
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

describe('PrReviewCommentComposer draft clear rules', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    createCommentMocks.mutateAsync.mockReset();
    createCommentMocks.isPending = false;
    createCommentMocks.error = null;
    vi.clearAllMocks();
  });

  it('clears the draft on add-to-review', () => {
    const element = mountComposer();
    typeBody(element, 'hello');
    footerProp(element, 'onAddToReview')?.();

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-comment:key');
  });

  it('clears the draft on a successful comment post', async () => {
    createCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const element = mountComposer();
    typeBody(element, 'hello');
    footerProp(element, 'onCommentNow')?.();
    await flushMicrotasks();

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-comment:key');
  });

  it('clears the draft on a confirmed discard', () => {
    const element = mountComposer();
    typeBody(element, 'hello');
    footerProp(element, 'onCancel')?.();

    const call = alertCalls.at(-1);
    if (!call) {
      throw new Error('No discard Alert was shown');
    }
    call.buttons.find(b => b.style === 'destructive')?.onPress?.();

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-comment:key');
  });

  it('does not clear the draft on a dismissed-without-confirmation discard', () => {
    const element = mountComposer();
    typeBody(element, 'hello');
    footerProp(element, 'onCancel')?.();

    const call = alertCalls.at(-1);
    if (!call) {
      throw new Error('No discard Alert was shown');
    }
    call.buttons.find(b => b.text === 'Keep editing')?.onPress?.();

    expect(clearDraft).not.toHaveBeenCalled();
  });
});
