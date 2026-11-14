// Mounted coverage for the create-mode comment composer's one submit phase:
// the phase the surface published is the only admission and pending authority,
// so a second tap during the Terms round-trip is dropped and a rejection
// followed by an empty-body submit still renders and announces its own copy.
//
// Real React state, real ComposerInlineError, native children stubbed.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrReviewCommentComposer } from './pr-review-comment-composer';
import { PR_OPERATION_PERSISTENCE_FAILED_MESSAGE } from '@/lib/pr-review/merge/pr-operation-ledger';
import { clearDraft } from '@/lib/persist/drafts';

// The Expo modules below read the build-time `__DEV__` global at import time
// and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { announcement, connectivity, createComment, draftLoad, gate, pendingReview, termsStatus } =
  vi.hoisted(() => ({
    announcement: { announce: vi.fn() },
    connectivity: { value: 'online' },
    createComment: {
      mutateAsync: vi.fn<() => Promise<unknown>>(),
      publish: { current: null as ((state: { error: Error | null }) => void) | null },
    },
    draftLoad: { value: { settled: true, value: null as string | null } },
    gate: { status: vi.fn<() => Promise<{ accepted: boolean; currentVersion: string }>>() },
    pendingReview: { addComment: vi.fn() },
    termsStatus: { accept: vi.fn<() => Promise<unknown>>() },
  }));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetFooter: 'PrFormSheetFooter',
  PrFormSheetHeader: 'PrFormSheetHeader',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: announcement.announce }));
vi.mock('@/lib/haptics', () => ({ impactHaptic: vi.fn(), notificationHaptic: vi.fn() }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  connectionRefusesWrites: () =>
    connectivity.value === 'offline' || connectivity.value === 'confirming-offline',
  getCommittedConnectivityStatus: () => connectivity.value,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));

vi.mock('@/lib/persist/drafts', () => ({
  clearDraft: vi.fn(),
  prCommentDraftKey: vi.fn(() => 'pr-comment:key'),
  prMergeDraftKey: vi.fn(),
  prReplyDraftKey: vi.fn(),
  saveDraft: vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => draftLoad.value,
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));

vi.mock('@/lib/pr-review/build-suggestion-fence', () => ({ buildSuggestionFence: () => null }));
vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({ getDiffSelection: () => null }));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({
    addComment: pendingReview.addComment,
    clear: vi.fn(),
    items: [],
    removeComment: vi.fn(),
    updateComment: vi.fn(),
  }),
}));
// The branch composer reads only the rejection it classifies; main's version
// renders from the hook's `error` field. The mock carries it in real state, so
// a rejected write re-renders as the query does and one suite runs against
// either implementation.
vi.mock('@/lib/pr-review/use-pr-review-mutations', async () => {
  const React = await import('react');
  return {
    useCreateReviewCommentMutation: () => {
      const [state, setState] = React.useState<{ error: Error | null }>({ error: null });
      React.useEffect(() => {
        createComment.publish.current = setState;
      }, []);
      return {
        error: state.error,
        isPending: false,
        mutateAsync: createComment.mutateAsync,
      };
    },
  };
});

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    moderation: {
      acceptTerms: { mutate: () => termsStatus.accept() },
      getTermsStatus: { query: () => gate.status() },
    },
  },
}));

const baseProps = {
  eyebrow: 'octocat/hello#1',
  line: 10,
  mode: { headSha: 'a'.repeat(40), kind: 'create' },
  number: 1,
  onDismiss: vi.fn(),
  owner: 'octocat',
  path: 'src/a.ts',
  repo: 'hello',
  side: 'RIGHT',
  title: 'Comment',
} as const;

const mounted: ReactTestRenderer[] = [];

async function mountComposer(): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(createElement(PrReviewCommentComposer, baseProps));
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Button')
    .find(node => node.props.accessibilityLabel === label);
}

function press(renderer: ReactTestRenderer, label: string): void {
  const target = button(renderer, label);
  if (!target) {
    throw new Error(`no ${label} button`);
  }
  act(() => {
    (target.props.onPress as () => void)();
  });
}

async function pressAndSettle(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    press(renderer, label);
    await Promise.resolve();
  });
}

function typeBody(renderer: ReactTestRenderer, text: string): void {
  const field = renderer.root.findByType('TextInput');
  act(() => {
    (field.props.onChangeText as (value: string) => void)(text);
  });
}

function hasCopy(renderer: ReactTestRenderer, copy: string): boolean {
  return renderer.root.findAllByType('Text').some(node => node.props.children === copy);
}

function hasReconnectNotice(renderer: ReactTestRenderer): boolean {
  return renderer.root.findAllByType('PrReviewReconnectNotice').length > 0;
}

function isDisabled(renderer: ReactTestRenderer, label: string): boolean {
  return button(renderer, label)?.props.disabled === true;
}

const BODY_EMPTY = 'Comment body cannot be empty.';
const NOT_RECORDED = 'We could not record this action. Please try again later.';

beforeEach(() => {
  createComment.publish.current = null;
  draftLoad.value = { settled: true, value: null };
  connectivity.value = 'online';
  createComment.mutateAsync.mockReset();
  gate.status.mockReset();
  gate.status.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
  termsStatus.accept.mockReset();
  announcement.announce.mockReset();
  pendingReview.addComment.mockReset();
  vi.mocked(clearDraft).mockReset();
  baseProps.onDismiss.mockReset();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('PrReviewCommentComposer submit phase', () => {
  it('announces an empty body, then posts once a body is typed', async () => {
    createComment.mutateAsync.mockResolvedValue({});
    const renderer = await mountComposer();

    press(renderer, 'Comment now');
    expect(hasCopy(renderer, BODY_EMPTY)).toBe(true);
    expect(announcement.announce).toHaveBeenCalledWith(BODY_EMPTY);
    expect(isDisabled(renderer, 'Comment now')).toBe(true);
    expect(isDisabled(renderer, 'Add to review')).toBe(false);

    typeBody(renderer, 'hello');
    expect(hasCopy(renderer, BODY_EMPTY)).toBe(false);
    expect(isDisabled(renderer, 'Comment now')).toBe(false);

    await pressAndSettle(renderer, 'Comment now');
    expect(createComment.mutateAsync).toHaveBeenCalledTimes(1);
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders and announces the empty body after a reconnect-classified failure', async () => {
    const rejection = Object.assign(new Error('GitHub connection expired'), {
      data: { code: 'PRECONDITION_FAILED' },
    });
    // A rejected write also lands in the hook's `error`, which is what main's
    // version renders from.
    createComment.mutateAsync.mockImplementation(() => {
      createComment.publish.current?.({ error: rejection });
      return Promise.reject(rejection);
    });
    const renderer = await mountComposer();
    typeBody(renderer, 'hello');
    await pressAndSettle(renderer, 'Comment now');
    expect(hasReconnectNotice(renderer)).toBe(true);
    expect(isDisabled(renderer, 'Comment now')).toBe(true);

    // Deleting the body retires the recoverable kinds only; the reconnect
    // failure is still on screen when the secondary CTA is pressed.
    typeBody(renderer, '');
    expect(hasReconnectNotice(renderer)).toBe(true);
    press(renderer, 'Add to review');

    expect(hasCopy(renderer, BODY_EMPTY)).toBe(true);
    expect(announcement.announce).toHaveBeenLastCalledWith(BODY_EMPTY);
    expect(hasReconnectNotice(renderer)).toBe(false);
    expect(pendingReview.addComment).not.toHaveBeenCalled();
    expect(baseProps.onDismiss).not.toHaveBeenCalled();
  });

  it('blocks the primary on an unrecorded intent and recovers on an edit', async () => {
    const rejection = new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
    createComment.mutateAsync.mockImplementation(() => {
      createComment.publish.current?.({ error: rejection });
      return Promise.reject(rejection);
    });
    const renderer = await mountComposer();
    typeBody(renderer, 'hello');
    await pressAndSettle(renderer, 'Comment now');

    expect(hasCopy(renderer, NOT_RECORDED)).toBe(true);
    // The intent never reached the ledger: the same body must not be retried.
    expect(isDisabled(renderer, 'Comment now')).toBe(true);

    // An edit is a new intent, so the line retires and the CTA returns.
    typeBody(renderer, 'hello again');
    expect(hasCopy(renderer, NOT_RECORDED)).toBe(false);
    expect(isDisabled(renderer, 'Comment now')).toBe(false);
  });

  it('issues one comment for two taps during the Terms status round-trip', async () => {
    const roundTrip = Promise.withResolvers<{ accepted: boolean; currentVersion: string }>();
    gate.status.mockReturnValueOnce(roundTrip.promise);
    createComment.mutateAsync.mockResolvedValue({});
    const renderer = await mountComposer();
    typeBody(renderer, 'hello');

    act(() => {
      press(renderer, 'Comment now');
    });
    act(() => {
      press(renderer, 'Comment now');
    });
    expect(renderer.root.findByType('TextInput').props.editable).toBe(false);

    await act(async () => {
      roundTrip.resolve({ accepted: true, currentVersion: 'v1' });
      await Promise.resolve();
    });

    expect(createComment.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the composer is dismissed during the Terms read', async () => {
    const roundTrip = Promise.withResolvers<{ accepted: boolean; currentVersion: string }>();
    gate.status.mockReturnValueOnce(roundTrip.promise);
    const renderer = await mountComposer();
    typeBody(renderer, 'hello');

    act(() => {
      press(renderer, 'Comment now');
      press(renderer, 'Cancel');
    });

    await act(async () => {
      roundTrip.resolve({ accepted: true, currentVersion: 'v1' });
      await Promise.resolve();
    });

    // The gate resolved for an attempt the dismissal already abandoned.
    expect(createComment.mutateAsync).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it.each(['offline', 'confirming-offline'] as const)(
    'fails locally while the connection refuses writes (%s)',
    async phase => {
      // A write dispatched in the confirming window waits out its deadline on a
      // transport that just went away, so both phases fail locally.
      connectivity.value = phase;
      const renderer = await mountComposer();
      typeBody(renderer, 'hello');
      await pressAndSettle(renderer, 'Comment now');

      expect(createComment.mutateAsync).not.toHaveBeenCalled();
      expect(hasCopy(renderer, 'Could not post comment.')).toBe(true);
      expect(isDisabled(renderer, 'Comment now')).toBe(false);
    }
  );
});
