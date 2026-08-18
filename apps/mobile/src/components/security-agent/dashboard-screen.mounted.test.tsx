/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. */
/* eslint-disable max-lines -- the sync-control, dismiss-card, and reconcile-card suites share one mock harness in this file */

// Dashboard sync-control terminal-state contract: a non-retryable sync outcome
// (missing-configuration rejection, persistence failure) ends the intent — the
// hook rotates the operation key, so both sync controls ("Sync now" header
// button and the "Sync findings" empty-state action) must disable and the
// inline copy must explain the state. The missing-configuration rejection shows
// the state-specific configuration copy in place of the raw server message.
// Retryable failures keep both controls enabled so the user can retry under the
// same hoisted key.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardScreen } from './dashboard-screen';

const PERSISTENCE_FAILED_MESSAGE = vi.hoisted(
  () => 'We could not record this action. Please try again later.'
);
const IN_PROGRESS_COPY = vi.hoisted(
  () => 'A security sync is already in progress. Please try again.'
);
const CONFIGURATION_ERROR_MESSAGE = vi.hoisted(() => 'Security service is not configured');
const CONFIGURATION_COPY = vi.hoisted(
  () => 'Security service is not configured. Resubmitting cannot succeed until this is fixed.'
);
const RECONCILE_COPY = vi.hoisted(
  () => 'A sync may not have completed. Retry to reconcile it, or discard.'
);

const triggerSync = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as Error | null,
}));
const config = vi.hoisted(() => ({
  data: { slaEnabled: true },
}));
const dashboardStats = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  data: { sla: { overall: { total: 0 } } },
  refetch: vi.fn(),
}));
const lastSync = vi.hoisted(() => ({
  data: undefined as { lastSyncTime?: string } | undefined,
  isError: false,
  refetch: vi.fn(),
}));
const repositories = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  data: [] as unknown[],
}));
const capability = vi.hoisted(() => ({
  canManage: false,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const dismissFailures = vi.hoisted(() => ({
  failures: [] as { findingId: string; lastError: string; retryable: boolean | null }[],
  clear: vi.fn(),
  refresh: vi.fn(),
}));
const outbox = vi.hoisted(() => ({
  needsReconcile: [] as {
    operationKey: string;
    fingerprint: string;
    scope: string;
    input: unknown;
  }[],
  remove: vi.fn(),
  refresh: vi.fn(),
}));

// Captures the useFocusEffect callback so a test can simulate a focus event.
const focusEffect = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
}));

// Captures the retry-card props the dashboard renders per failure.
const retryCards = vi.hoisted(() => ({
  cards: [] as {
    lastError: string;
    retryable: boolean;
    onRetry?: () => void;
    onDiscard?: () => void;
  }[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
}));
vi.mock('@/components/ui/icons', () => ({
  RefreshCw: 'RefreshCw',
  Settings: 'Settings',
  ShieldAlert: 'ShieldAlert',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: (effect: () => void) => {
    focusEffect.effect = effect;
  },
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666', primary: '#000' }),
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSecurityAgentDashboardStats: () => dashboardStats,
  useSecurityAgentLastSyncTime: () => lastSync,
  useSecurityAgentRepositories: () => repositories,
  useTriggerSecuritySync: () => triggerSync,
}));
vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissFailures: () => dismissFailures,
}));
vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outbox,
}));
vi.mock('@/components/security-agent/security-command-retry-card', () => ({
  SecurityCommandRetryCard: (props: {
    lastError: string;
    retryable: boolean;
    onRetry?: () => void;
    onDiscard?: () => void;
  }) => {
    retryCards.cards.push(props);
    return null;
  },
}));
// Faithful-enough mirror of the real classifier (covered by its own suite):
// the persistence-failure and replay-failed markers and the
// missing-configuration rejection are non-retryable, the rest (transport,
// in-progress copy, ambiguous, settle-failed) are retryable.
vi.mock('@/lib/hooks/use-security-agent-mutations', () => ({
  isSecurityConfigurationError: (error: unknown) =>
    error instanceof Error && error.message === CONFIGURATION_ERROR_MESSAGE,
  SECURITY_CONFIGURATION_COPY: CONFIGURATION_COPY,
  SECURITY_SYNC_RECONCILE_COPY: RECONCILE_COPY,
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
vi.mock('@kilocode/app-shared/security-agent', () => ({
  buildSecurityDashboardMetrics: () => [],
  getSecurityRepositoriesInScope: () => [],
}));
vi.mock('@/lib/security-agent', () => ({
  getSecurityAgentPath: (scope: string, section: string) => `/security/${scope}/${section}`,
}));
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  parseTimestamp: (value: string) => value,
  timeAgo: () => 'recently',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/query-error', () => ({ QueryError: () => null }));
vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: () => null,
}));
vi.mock('@/components/security-agent/dashboard-sections', () => ({
  DashboardSections: () => null,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderScreen(): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(DashboardScreen, { scope: 'personal' }));
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function syncButtons(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      (n.props.accessibilityLabel === 'Sync now' || n.props.accessibilityLabel === 'Sync findings')
  );
}

function findSyncButton(root: I, label: 'Sync now' | 'Sync findings'): I {
  const nodes = syncButtons(root).filter(n => n.props.accessibilityLabel === label);
  const n = nodes[0];
  if (!n) {
    throw new Error(`expected 1 ${label} button, got ${nodes.length}`);
  }
  return n;
}

function syncDisabledStates(root: I): boolean[] {
  return syncButtons(root).map(n => n.props.disabled as boolean);
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

describe('DashboardScreen sync control terminal states', () => {
  beforeEach(() => {
    triggerSync.mutate.mockClear();
    triggerSync.isPending = false;
    triggerSync.isError = false;
    triggerSync.error = null;
    config.data = { slaEnabled: true };
    dashboardStats.isLoading = false;
    dashboardStats.isError = false;
    dashboardStats.data = { sla: { overall: { total: 0 } } };
    lastSync.data = undefined;
    lastSync.isError = false;
    repositories.isLoading = false;
    repositories.isError = false;
    repositories.data = [];
    capability.canManage = false;
    dismissFailures.failures = [];
    dismissFailures.clear.mockClear();
    dismissFailures.refresh.mockClear();
    outbox.needsReconcile = [];
    outbox.remove.mockClear();
    outbox.refresh.mockClear();
    retryCards.cards = [];
    focusEffect.effect = undefined;
  });

  it('keeps both sync controls enabled in the happy state', () => {
    const root = renderScreen();

    expect(syncButtons(root.root)).toHaveLength(2);
    expect(syncDisabledStates(root.root)).toEqual([false, false]);
  });

  it('keeps both sync controls enabled after a retryable error and shows its copy', () => {
    triggerSync.isError = true;
    triggerSync.error = new Error(IN_PROGRESS_COPY);
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([false, false]);
    expect(renderedTexts(root.root)).toContain(IN_PROGRESS_COPY);
  });

  it('disables both sync controls and shows configuration-specific copy after a missing-configuration error', () => {
    triggerSync.isError = true;
    triggerSync.error = new Error(CONFIGURATION_ERROR_MESSAGE);
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true, true]);
    expect(renderedTexts(root.root)).toContain(CONFIGURATION_COPY);
    // The raw server message is replaced by the state-specific copy.
    expect(renderedTexts(root.root)).not.toContain(CONFIGURATION_ERROR_MESSAGE);
  });

  it('disables both sync controls and shows the error copy after another non-retryable error', () => {
    triggerSync.isError = true;
    triggerSync.error = new Error(PERSISTENCE_FAILED_MESSAGE);
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true, true]);
    expect(renderedTexts(root.root)).toContain(PERSISTENCE_FAILED_MESSAGE);
  });

  it('disables both sync controls while a sync is pending', () => {
    triggerSync.isPending = true;
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true, true]);
  });

  it('submits the sync through the header control with the current repo filter', () => {
    const root = renderScreen();
    const syncNow = findSyncButton(root.root, 'Sync now');

    act(() => {
      (syncNow.props.onPress as () => void)();
    });

    expect(triggerSync.mutate).toHaveBeenCalledWith(
      { repoFullName: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});

describe('DashboardScreen dismiss failure card states', () => {
  beforeEach(() => {
    dismissFailures.failures = [];
    dismissFailures.clear.mockClear();
    dismissFailures.refresh.mockClear();
    outbox.needsReconcile = [];
    outbox.remove.mockClear();
    outbox.refresh.mockClear();
    retryCards.cards = [];
    focusEffect.effect = undefined;
  });

  it('renders no retry card when there are no failed dismissals (empty)', () => {
    dismissFailures.failures = [];
    renderScreen();

    expect(retryCards.cards).toHaveLength(0);
  });

  it('renders a retry card with the error and Retry for a retryable failure', () => {
    dismissFailures.failures = [{ findingId: 'f1', lastError: 'Network error', retryable: true }];
    renderScreen();

    expect(retryCards.cards).toHaveLength(1);
    expect(retryCards.cards[0]?.lastError).toBe('Network error');
    expect(retryCards.cards[0]?.retryable).toBe(true);
  });

  it('renders a retry card with the error and no Retry for a non-retryable failure', () => {
    dismissFailures.failures = [
      { findingId: 'f1', lastError: 'Security service is not configured', retryable: false },
    ];
    renderScreen();

    expect(retryCards.cards).toHaveLength(1);
    expect(retryCards.cards[0]?.lastError).toBe('Security service is not configured');
    expect(retryCards.cards[0]?.retryable).toBe(false);
  });

  it('drops the card after accept by clearing the failure', () => {
    dismissFailures.failures = [{ findingId: 'f1', lastError: 'boom', retryable: true }];
    renderScreen();
    expect(retryCards.cards).toHaveLength(1);

    act(() => {
      retryCards.cards[0]?.onDiscard?.();
    });

    expect(dismissFailures.clear).toHaveBeenCalledWith('f1');
  });

  it('re-reads the failed dismissals on focus', () => {
    renderScreen();

    act(() => {
      focusEffect.effect?.();
    });

    expect(dismissFailures.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardScreen reconcile card states', () => {
  beforeEach(() => {
    dismissFailures.failures = [];
    dismissFailures.clear.mockClear();
    dismissFailures.refresh.mockClear();
    outbox.needsReconcile = [];
    outbox.remove.mockClear();
    outbox.refresh.mockClear();
    retryCards.cards = [];
    focusEffect.effect = undefined;
    triggerSync.mutate.mockClear();
  });

  it('renders no card when there are no reconcile rows (empty)', () => {
    outbox.needsReconcile = [];
    renderScreen();

    expect(retryCards.cards).toHaveLength(0);
  });

  it('renders a retryable card for a reconcile-first row and does not auto-POST', () => {
    outbox.needsReconcile = [
      {
        operationKey: 'op-1',
        fingerprint: 'fp-1',
        scope: 'personal',
        input: { repoFullName: 'kilo/repo' },
      },
    ];
    renderScreen();

    expect(retryCards.cards).toHaveLength(1);
    expect(retryCards.cards[0]?.lastError).toBe(RECONCILE_COPY);
    expect(retryCards.cards[0]?.retryable).toBe(true);
    // A reconcile-first row is never auto-replayed: no POST on render.
    expect(triggerSync.mutate).not.toHaveBeenCalled();
  });

  it('renders no card for a reconcile row from another scope', () => {
    outbox.needsReconcile = [
      {
        operationKey: 'op-1',
        fingerprint: 'fp-1',
        scope: 'other-org',
        input: { repoFullName: 'kilo/repo' },
      },
    ];
    renderScreen();

    expect(retryCards.cards).toHaveLength(0);
  });

  it('re-POSTs with the stored operationKey on retry', () => {
    outbox.needsReconcile = [
      {
        operationKey: 'op-1',
        fingerprint: 'fp-1',
        scope: 'personal',
        input: { repoFullName: 'kilo/repo' },
      },
    ];
    renderScreen();

    act(() => {
      retryCards.cards[0]?.onRetry?.();
    });

    expect(triggerSync.mutate).toHaveBeenCalledWith(
      { repoFullName: 'kilo/repo', operationKey: 'op-1' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onSettled: expect.any(Function),
      })
    );
  });

  it('removes the outbox row on discard', () => {
    outbox.needsReconcile = [
      {
        operationKey: 'op-1',
        fingerprint: 'fp-1',
        scope: 'personal',
        input: { repoFullName: 'kilo/repo' },
      },
    ];
    renderScreen();

    act(() => {
      retryCards.cards[0]?.onDiscard?.();
    });

    expect(outbox.remove).toHaveBeenCalledWith('fp-1');
  });

  it('re-reads the outbox on focus', () => {
    renderScreen();

    act(() => {
      focusEffect.effect?.();
    });

    expect(outbox.refresh).toHaveBeenCalledTimes(1);
  });
});
