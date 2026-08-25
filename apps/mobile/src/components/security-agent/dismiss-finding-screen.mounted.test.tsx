/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. */
/* eslint-disable max-lines -- the CTA terminal-state and draft-on-type suites share one screen harness. */

// Dismiss-screen terminal-state contract: a persistence failure (the ledger
// could not record the outcome, so a same-key retry guarantee does not hold)
// and a missing-configuration rejection are non-retryable — the form must show
// its state-specific copy and disable the dismissal CTA. Retryable failures
// (in-progress, ambiguous, transport) keep the CTA so the user can retry
// under the same hoisted key.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DismissFindingScreen } from './dismiss-finding-screen';

const PERSISTENCE_FAILED_MESSAGE = vi.hoisted(
  () => 'We could not record this action. Please try again later.'
);
const IN_PROGRESS_COPY = vi.hoisted(
  () => 'This dismissal is already in progress. Please try again.'
);
const CONFIGURATION_ERROR_MESSAGE = vi.hoisted(() => 'Security service is not configured');
const CONFIGURATION_COPY = vi.hoisted(
  () => 'Security service is not configured. Resubmitting cannot succeed until this is fixed.'
);

const routerBack = vi.hoisted(() => vi.fn());
const dismiss = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as Error | null,
}));
const capability = vi.hoisted(() => ({
  canManage: true,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const finding = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  error: null as unknown,
  data: { status: 'open' },
  refetch: vi.fn(),
}));
const pillGroup = vi.hoisted(() => ({
  onChange: (() => undefined) as (value: string) => void,
}));
const dismissDraft = vi.hoisted(() => ({
  draft: null as unknown,
  hydrated: true,
  persist: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/icons', () => ({ ShieldOff: 'ShieldOff' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000', primaryForeground: '#fff' }),
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useSecurityFinding: () => finding,
  useDismissSecurityFinding: () => dismiss,
}));
vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissDraft: () => dismissDraft,
}));
// Faithful-enough mirror of the real classifier (covered by its own suite):
// the persistence-failure and replay-failed markers and the
// missing-configuration rejection are non-retryable, the rest (transport,
// in-progress copy, ambiguous, settle-failed) are retryable.
vi.mock('@/lib/hooks/use-security-agent-mutations', () => ({
  isSecurityConfigurationError: (error: unknown) =>
    error instanceof Error && error.message === CONFIGURATION_ERROR_MESSAGE,
  securityConfigurationCopy: () => CONFIGURATION_COPY,
  isSecuritySyncRetryable: (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    return !(
      message === 'We could not record this action. Please try again later.' ||
      message === 'This action did not complete. Please try again.' ||
      message === 'operation_key_reuse_mismatch' ||
      message === CONFIGURATION_ERROR_MESSAGE
    );
  },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/empty-state', () => ({ EmptyState: () => null }));
vi.mock('@/components/query-error', () => ({ QueryError: () => null }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/security-agent/settings-pill-group', () => ({
  PillGroup: (props: { onChange: (value: string) => void }) => {
    pillGroup.onChange = props.onChange;
    return null;
  },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderScreen(): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(DismissFindingScreen, { scope: 'personal', findingId: 'finding-1' })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function selectReason(): void {
  act(() => {
    pillGroup.onChange('not_used');
  });
}

function findDismissButton(root: I): I {
  const nodes = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button');
  if (nodes.length !== 1) {
    throw new Error(`expected 1 dismissal Button, got ${nodes.length}`);
  }
  const n = nodes[0];
  if (!n) {
    throw new Error('dismissal Button not found');
  }
  return n;
}

function buttonDisabled(root: I): boolean | undefined {
  return findDismissButton(root).props.disabled as boolean | undefined;
}

function renderedTexts(root: I): string[] {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

function findCommentInput(root: I): I {
  const nodes = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'TextInput');
  const n = nodes[0];
  if (!n) {
    throw new Error('comment TextInput not found');
  }
  return n;
}

describe('DismissFindingScreen dismissal CTA states', () => {
  beforeEach(() => {
    dismiss.mutate.mockClear();
    dismiss.isPending = false;
    dismiss.isError = false;
    dismiss.error = null;
    capability.canManage = true;
    capability.isLoading = false;
    capability.isError = false;
    finding.isLoading = false;
    finding.isError = false;
    finding.data = { status: 'open' };
    dismissDraft.draft = null;
    dismissDraft.hydrated = true;
    dismissDraft.persist.mockClear();
    dismissDraft.clear.mockClear();
  });

  it('keeps the dismissal CTA enabled once a reason is chosen', () => {
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(false);
  });

  it('keeps the dismissal CTA enabled after a retryable failure and shows its copy', () => {
    dismiss.isError = true;
    dismiss.error = new Error(IN_PROGRESS_COPY);
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(false);
    expect(renderedTexts(root.root)).toContain(IN_PROGRESS_COPY);
  });

  it('disables the dismissal CTA and shows the persistence-failure copy after a non-retryable error', () => {
    dismiss.isError = true;
    dismiss.error = new Error(PERSISTENCE_FAILED_MESSAGE);
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(PERSISTENCE_FAILED_MESSAGE);
  });

  it('disables the dismissal CTA and shows configuration-specific copy after a missing-configuration error', () => {
    dismiss.isError = true;
    dismiss.error = new Error(CONFIGURATION_ERROR_MESSAGE);
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(CONFIGURATION_COPY);
    // The raw server message is replaced by the state-specific copy.
    expect(renderedTexts(root.root)).not.toContain(CONFIGURATION_ERROR_MESSAGE);
  });

  it('disables the dismissal CTA while the dismissal is pending', () => {
    dismiss.isPending = true;
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
  });

  it('submits the dismissal and pops the screen only on success', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    expect(dismiss.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: 'finding-1', reason: 'not_used' }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });

  it('records the intent as a draft before submitting', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    expect(dismissDraft.persist).toHaveBeenCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: null,
      retryable: null,
    });
  });

  it('clears the draft and pops on authoritative accept', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onSuccess?: () => void;
    };
    act(() => {
      options.onSuccess?.();
    });

    expect(dismissDraft.clear).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('persists lastError and retryable on a retryable failure', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onError?: (error: Error) => void;
    };
    act(() => {
      options.onError?.(new Error(IN_PROGRESS_COPY));
    });

    expect(dismissDraft.persist).toHaveBeenLastCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: IN_PROGRESS_COPY,
      retryable: true,
    });
  });

  it('persists the configuration copy and non-retryable on a missing-configuration failure', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onError?: (error: Error) => void;
    };
    act(() => {
      options.onError?.(new Error(CONFIGURATION_ERROR_MESSAGE));
    });

    expect(dismissDraft.persist).toHaveBeenLastCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: CONFIGURATION_COPY,
      retryable: false,
    });
  });
});

describe('DismissFindingScreen draft persistence on type', () => {
  it('persists the reason as a draft on selection', () => {
    renderScreen();
    selectReason();

    expect(dismissDraft.persist).toHaveBeenCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: null,
      retryable: null,
    });
  });

  it('persists the comment as a draft on typing', () => {
    const root = renderScreen();

    act(() => {
      (findCommentInput(root.root).props.onChangeText as (value: string) => void)('some context');
    });

    expect(dismissDraft.persist).toHaveBeenCalledWith({
      reason: '',
      comment: 'some context',
      lastError: null,
      retryable: null,
    });
  });

  it('preserves the last failure when typing after a failure', () => {
    dismissDraft.draft = { reason: 'not_used', comment: '', lastError: 'boom', retryable: true };
    const root = renderScreen();

    act(() => {
      (findCommentInput(root.root).props.onChangeText as (value: string) => void)('edited');
    });

    expect(dismissDraft.persist).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'edited', lastError: 'boom', retryable: true })
    );
  });
});
