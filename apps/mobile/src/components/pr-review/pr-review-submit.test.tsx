/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/pr-review/pending-review-provider.mounted.test.tsx */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake mutation and drafts factories settle without await because they resolve immediately */
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewSubmit } from './pr-review-submit';
import {
  type PendingReviewItem,
  PendingReviewProvider,
  usePendingReview,
} from '@/lib/pr-review/pending-review-provider';

const submitMutationMock = vi.hoisted(() => ({
  mutateAsync: vi.fn(async (): Promise<unknown> => undefined),
}));

vi.mock('@/lib/pr-review/use-pr-review-mutations', () => ({
  useSubmitReviewMutation: () => ({
    mutateAsync: submitMutationMock.mutateAsync,
    isPending: false,
    error: null,
  }),
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: vi.fn(async () => ({ kind: 'accepted' as const })),
  TERMS_CHECK_RETRY_COPY: 'terms-check-retry',
  TERMS_OUTDATED_COPY: 'terms-outdated',
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('@/lib/persist/drafts', () => ({
  loadDraft: vi.fn(async (): Promise<unknown> => null),
  saveDraft: vi.fn(async (): Promise<void> => undefined),
  clearDraft: vi.fn(async (): Promise<void> => undefined),
  prReviewDraftKey: (owner: string, repo: string, number: number) =>
    `pr-review:${owner}/${repo}#${number}`,
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({
  useDraftFlushOnBackground: vi.fn(),
}));

// `mutation-error-display` imports the PR operation-ledger helpers, which
// import `expo-crypto` (and transitively expo-modules-core). Mock it so this
// suite stays node-only, same as the other ledger pure tests.
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used-in-pure-tests',
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetFooter: 'PrFormSheetFooter',
  PrFormSheetHeader: 'PrFormSheetHeader',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/review-event-chips', () => ({
  ReviewEventChips: 'ReviewEventChips',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-pending-comment-row', () => ({
  focusAfterPendingCommentRemoval: vi.fn(),
  PendingQueueHint: 'PendingQueueHint',
  PrReviewPendingCommentRow: 'PrReviewPendingCommentRow',
  ReviewSummaryField: 'ReviewSummaryField',
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

const ITEM_FRESH_A: PendingReviewItem = {
  id: 'fresh-a',
  path: 'src/a.ts',
  side: 'RIGHT',
  line: 1,
  body: 'A',
  commitSha: 'head-1',
};
const ITEM_FRESH_B: PendingReviewItem = {
  id: 'fresh-b',
  path: 'src/b.ts',
  side: 'RIGHT',
  line: 2,
  body: 'B',
  commitSha: 'head-1',
};
const ITEM_STALE: PendingReviewItem = {
  id: 'stale-c',
  path: 'src/c.ts',
  side: 'RIGHT',
  line: 3,
  body: 'C',
  commitSha: 'head-0',
};

let latestItems: PendingReviewItem[] = [];
let addCommentFn: ((item: PendingReviewItem) => void) | null = null;

function Consumer() {
  const value = usePendingReview();
  latestItems = value.items;
  addCommentFn = value.addComment;
  return null;
}

function mount(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      <PendingReviewProvider>
        <Consumer />
        <PrReviewSubmit
          owner="acme"
          repo="kilo"
          number={42}
          headSha="head-1"
          title="Submit review"
          eyebrow="acme/kilo#42"
          onDismiss={vi.fn(() => undefined)}
        />
      </PendingReviewProvider>
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to mount PrReviewSubmit');
  }
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function submitOnPress(renderer: TestRenderer.ReactTestRenderer): () => void {
  const button = renderer.root.findAll(
    node => node.props.accessibilityLabel === 'Submit 2 of 3 comments'
  )[0];
  if (!button) {
    throw new Error('Submit button not found');
  }
  return button.props.onPress as () => void;
}

beforeEach(() => {
  latestItems = [];
  addCommentFn = null;
  submitMutationMock.mutateAsync.mockReset();
  submitMutationMock.mutateAsync.mockResolvedValue(undefined);
});

describe('PrReviewSubmit queue retention', () => {
  it('keeps every queued item when a submit fails', async () => {
    submitMutationMock.mutateAsync.mockRejectedValueOnce(new Error('network down'));
    const renderer = mount();

    act(() => {
      addCommentFn?.(ITEM_FRESH_A);
      addCommentFn?.(ITEM_FRESH_B);
      addCommentFn?.(ITEM_STALE);
    });
    expect(latestItems.map(item => item.id)).toEqual(['fresh-a', 'fresh-b', 'stale-c']);

    act(() => {
      submitOnPress(renderer)();
    });
    await flush();

    // A failed submit reaches the catch path, which drains nothing: the fresh
    // and stale items all stay queued, with no optimistic removal.
    expect(submitMutationMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(latestItems.map(item => item.id)).toEqual(['fresh-a', 'fresh-b', 'stale-c']);
  });

  it('removes only the fresh items on success, leaving stale items queued', async () => {
    const renderer = mount();

    act(() => {
      addCommentFn?.(ITEM_FRESH_A);
      addCommentFn?.(ITEM_FRESH_B);
      addCommentFn?.(ITEM_STALE);
    });

    act(() => {
      submitOnPress(renderer)();
    });
    await flush();

    // Success removes exactly the fresh ids; the stale item stays queued.
    expect(submitMutationMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(latestItems.map(item => item.id)).toEqual(['stale-c']);
  });
});
