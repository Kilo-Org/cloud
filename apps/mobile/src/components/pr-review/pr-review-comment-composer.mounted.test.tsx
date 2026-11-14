/* eslint-disable max-lines -- the draft-clear rules, the provider-arm anchoring and the inline-failure states share one composer harness */
// Mounted coverage for the create-comment composer: the durable draft clear
// rules, the provider-arm anchor, and the inline failure states the surface
// publishes through the shared surface-feedback store.

import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrReviewCommentComposer } from './pr-review-comment-composer';
import { clearDraft } from '@/lib/persist/drafts';
import { providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

// The Expo modules in this graph read the build-time `__DEV__` global when they
// load, and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { confirmRequests, createCommentMocks, gate } = vi.hoisted(() => ({
  confirmRequests: [] as ConfirmRequest[],
  createCommentMocks: {
    mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(),
  },
  gate: {
    ensureTermsAcceptedOutcome: vi.fn<() => Promise<{ kind: string }>>(),
  },
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: ConfirmRequest) => {
      confirmRequests.push(request);
    },
    dialog: null,
  }),
}));

vi.mock('react-native', () => ({
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
  Platform: { OS: 'ios' },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  useFormSheetKeyboardVisible: () => false,
}));

vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
  ComposerFooter: 'ComposerFooter',
  composerRangeLabel: (line: number, startLine?: number) =>
    startLine !== undefined && startLine !== line ? `L${startLine}–L${line}` : `L${line}`,
  ContextPreview: 'ContextPreview',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: gate.ensureTermsAcceptedOutcome,
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

vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));
vi.mock('@/lib/pr-review/build-suggestion-fence', () => ({ buildSuggestionFence: () => null }));
vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({ getDiffSelection: () => null }));

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
  useCreateReviewCommentMutation: () => ({ mutateAsync: createCommentMocks.mutateAsync }),
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

const gitlabRef = { platform: 'gitlab' as const, projectPath: 'octocat/hello', mrIid: 1 };

const mounted: ReactTestRenderer[] = [];

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

function bodyField(renderer: ReactTestRenderer) {
  return renderer.root.findByType('CommentBodyField');
}

function footer(renderer: ReactTestRenderer) {
  return renderer.root.findByType('ComposerFooter');
}

function typeBody(renderer: ReactTestRenderer, text: string): void {
  act(() => {
    (bodyField(renderer).props.onChangeText as (value: string) => void)(text);
  });
}

function pressFooter(renderer: ReactTestRenderer, prop: string): void {
  act(() => {
    (footer(renderer).props[prop] as () => void)();
  });
}

function primaryDisabled(renderer: ReactTestRenderer): boolean {
  return footer(renderer).props.primaryDisabled as boolean;
}

function failureCopy(renderer: ReactTestRenderer): string | undefined {
  const status = renderer.root.findAllByType('AccessibleStatus')[0];
  const text = renderer.root.findAllByType('Text')[0];
  return (status?.props.message ?? text?.props.children) as string | undefined;
}

function hasReconnectNotice(renderer: ReactTestRenderer): boolean {
  return renderer.root.findAllByType('PrReviewReconnectNotice').length > 0;
}

beforeEach(() => {
  confirmRequests.length = 0;
  createCommentMocks.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  vi.mocked(clearDraft).mockReset();
  baseProps.onDismiss = vi.fn();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('PrReviewCommentComposer draft clear rules', () => {
  it('clears the draft on add-to-review', async () => {
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    pressFooter(renderer, 'onAddToReview');

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-comment:key');
  });

  it('clears the draft on a successful comment post', async () => {
    createCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    await act(async () => {
      (footer(renderer).props.onCommentNow as () => void)();
    });

    // The GitHub arm keeps its exact pre-s6 variables: the position rides the
    // flat input fields, never the provider `anchor` shape (c3).
    expect(createCommentMocks.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      body: 'hello',
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      commitSha: 'a'.repeat(40),
    });
    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-comment:key');
  });

  it('clears the draft on a confirmed discard', async () => {
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    pressFooter(renderer, 'onCancel');

    expect(confirmRequests.at(-1)).toMatchObject({
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    });
    act(() => {
      confirmRequests.at(-1)?.onConfirm();
    });

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-comment:key');
  });

  it('does not clear the draft when the discard gate is dismissed without confirming', async () => {
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    pressFooter(renderer, 'onCancel');

    expect(confirmRequests.at(-1)?.cancelLabel).toBe('Keep editing');
    expect(clearDraft).not.toHaveBeenCalled();
  });
});

describe('PrReviewCommentComposer provider arm (s6)', () => {
  const providerProps = { ...baseProps, prRef: gitlabRef };

  it('posts the tapped diff position as the real anchor through the provider arm (c3)', async () => {
    createCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrReviewCommentComposer, providerProps));
    typeBody(renderer, 'hello');
    await act(async () => {
      (footer(renderer).props.onCommentNow as () => void)();
    });

    expect(createCommentMocks.mutateAsync).toHaveBeenCalledWith({
      body: 'hello',
      anchor: { path: 'src/a.ts', side: 'RIGHT', line: 10 },
    });
  });

  it('carries a multi-line range into the anchor (c3)', async () => {
    createCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(
      createElement(PrReviewCommentComposer, { ...providerProps, startLine: 8 })
    );
    typeBody(renderer, 'hello');
    await act(async () => {
      (footer(renderer).props.onCommentNow as () => void)();
    });

    expect(createCommentMocks.mutateAsync).toHaveBeenCalledWith({
      body: 'hello',
      anchor: { path: 'src/a.ts', side: 'RIGHT', line: 10, startLine: 8 },
    });
  });

  it('keeps the provider comment out of the pending queue path (comment now is direct)', async () => {
    const renderer = await mount(createElement(PrReviewCommentComposer, providerProps));
    typeBody(renderer, 'hello');
    pressFooter(renderer, 'onAddToReview');

    expect(createCommentMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('folds the provider ref identity into the durable comment draft key', async () => {
    const renderer = await mount(createElement(PrReviewCommentComposer, providerProps));
    typeBody(renderer, 'hello');
    pressFooter(renderer, 'onAddToReview');

    expect(clearDraft).toHaveBeenCalledWith('u1', `pr-comment:key@${providerPrRefKey(gitlabRef)}`);
  });
});

describe('PrReviewCommentComposer failure states', () => {
  it('re-enables the primary control after the typed body replaces an empty submit', async () => {
    createCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));

    await act(async () => {
      (footer(renderer).props.onCommentNow as () => void)();
    });
    expect(failureCopy(renderer)).toBe('Comment body cannot be empty.');
    expect(primaryDisabled(renderer)).toBe(true);

    typeBody(renderer, 'a valid body');
    expect(primaryDisabled(renderer)).toBe(false);

    await act(async () => {
      (footer(renderer).props.onCommentNow as () => void)();
    });
    expect(createCommentMocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(baseProps.onDismiss).toHaveBeenCalled();
  });

  it('retires a reconnect failure when the body is replaced by the empty-body validation', async () => {
    createCommentMocks.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('GitHub connection expired'), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    await act(async () => {
      (footer(renderer).props.onCommentNow as () => void)();
    });
    expect(hasReconnectNotice(renderer)).toBe(true);

    typeBody(renderer, '');
    pressFooter(renderer, 'onAddToReview');

    expect(hasReconnectNotice(renderer)).toBe(false);
    expect(failureCopy(renderer)).toBe('Add a comment before submitting.');
  });

  it('issues one request for two taps during the Terms status round-trip', async () => {
    const gateRoundTrip = Promise.withResolvers<{ kind: string }>();
    gate.ensureTermsAcceptedOutcome.mockReturnValueOnce(gateRoundTrip.promise);
    createCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrReviewCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    act(() => {
      (footer(renderer).props.onCommentNow as () => void)();
    });
    act(() => {
      (footer(renderer).props.onCommentNow as () => void)();
    });
    expect(primaryDisabled(renderer)).toBe(true);

    await act(async () => {
      gateRoundTrip.resolve({ kind: 'accepted' });
      await Promise.resolve();
    });

    expect(createCommentMocks.mutateAsync).toHaveBeenCalledTimes(1);
  });
});
