/* eslint-disable max-lines -- the sync-control, dismiss-card, and reconcile-card suites share one mock harness in this file */

// Dashboard sync-control terminal-state contract: a non-retryable sync outcome
// (missing-configuration rejection, persistence failure) ends the intent — the
// hook rotates the operation key, so both sync controls ("Sync now" header
// button and the "Sync findings" empty-state action) must disable and the
// inline copy must explain the state. The hook maps every failure onto catalog
// copy before it reaches the screen, so the banner renders the mapped message;
// these cases feed the real mapper's output.
// Retryable failures keep both controls enabled so the user can retry under the
// same hoisted key.

import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  mapSecuritySyncOperationError,
  SECURITY_AMBIGUOUS_MESSAGE,
} from '@/lib/security-agent-ledger';
import { buildLocalizedMetrics, DashboardScreen } from './dashboard-screen';

// The ledger module imports the operation-key helpers, whose expo-crypto root
// import loads a native binding this node project does not have.
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000000' }));

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
  isPending: false,
  isError: false,
  data: undefined as Record<string, unknown> | undefined,
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
  refetch: vi.fn(),
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
const sharedMetrics = vi.hoisted(() => ({
  build: vi.fn(),
}));
// The themed base the dashboard spreads into every sheet, and the sheet call
// captured by the repository-filter test.
const themedSheetOptions = vi.hoisted(() => ({
  autoFocus: true,
  useModal: true,
  containerStyle: { backgroundColor: '#17171A', paddingBottom: 34 },
  textStyle: { color: '#F2F0EB' },
  titleTextStyle: { color: '#8A8680' },
  messageTextStyle: { color: '#8A8680' },
  destructiveColor: '#F28B7A',
}));
const sheet = vi.hoisted(() => ({ show: vi.fn() }));

// Captures the useFocusEffect callback so a test can simulate a focus event.
const focusEffect = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
}));

// Captures the refresh control element the dashboard passes to the scroll view.
const tabScreen = vi.hoisted(() => ({
  refreshControl: undefined as unknown,
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

vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
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
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: sheet.show }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666', primary: '#000' }),
}));
vi.mock('@/lib/hooks/use-themed-action-sheet', () => ({
  useThemedActionSheetOptions: () => themedSheetOptions,
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
  securityDismissFailureCopy: (draft: { lastError: string }) => draft.lastError,
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
vi.mock('@kilocode/app-shared/security-agent', () => ({
  buildSecurityDashboardMetrics: sharedMetrics.build,
  getAnalysisIncompleteCount: (analysis: {
    triageComplete: number;
    analyzing: number;
    notAnalyzed: number;
    failed: number;
  }) => analysis.triageComplete + analysis.analyzing + analysis.notAnalyzed + analysis.failed,
  getSecurityRepositoriesInScope: () => [],
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
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
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown; refreshControl?: unknown }) => {
    tabScreen.refreshControl = props.refreshControl;
    return props.children;
  },
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

type SyncControlKey = 'securityAgent.dashboard.syncNow' | 'securityAgent.dashboard.syncFindings';

function syncButtons(root: I): I[] {
  const syncNow = i18n.t('securityAgent.dashboard.syncNow');
  const syncFindings = i18n.t('securityAgent.dashboard.syncFindings');
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      (n.props.accessibilityLabel === syncNow || n.props.accessibilityLabel === syncFindings)
  );
}

function findSyncButton(root: I, key: SyncControlKey): I {
  const label = i18n.t(key);
  const nodes = syncButtons(root).filter(n => n.props.accessibilityLabel === label);
  const n = nodes[0];
  if (!n) {
    throw new Error(`expected 1 ${label} button, got ${nodes.length}`);
  }
  return n;
}

function findFilterControl(root: I): I {
  const filter = root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityLabel === 'Filter by repository'
  )[0];
  if (!filter) {
    throw new Error('filter control not found');
  }
  return filter;
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

function dashboardMetric(id: string) {
  return { id, label: '', value: '', detail: '', tone: 'neutral' as const };
}

describe('DashboardScreen sync control terminal states', () => {
  beforeEach(() => {
    triggerSync.mutate.mockClear();
    triggerSync.isPending = false;
    triggerSync.isError = false;
    triggerSync.error = null;
    config.data = { slaEnabled: true };
    dashboardStats.isLoading = false;
    dashboardStats.isPending = false;
    dashboardStats.isError = false;
    dashboardStats.data = { sla: { overall: { total: 0 } } };
    lastSync.data = undefined;
    lastSync.isError = false;
    repositories.isLoading = false;
    repositories.isError = false;
    repositories.data = [];
    repositories.refetch.mockClear();
    capability.canManage = false;
    dismissFailures.failures = [];
    dismissFailures.clear.mockClear();
    dismissFailures.refresh.mockClear();
    outbox.needsReconcile = [];
    outbox.remove.mockClear();
    outbox.refresh.mockClear();
    retryCards.cards = [];
    focusEffect.effect = undefined;
    sharedMetrics.build.mockReturnValue([]);
  });

  it('keeps both sync controls enabled in the happy state', () => {
    const root = renderScreen();

    expect(syncButtons(root.root)).toHaveLength(2);
    expect(syncDisabledStates(root.root)).toEqual([false, false]);
  });

  it('keeps both sync controls enabled after a retryable error and shows its copy', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error('operation_in_progress'));
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([false, false]);
    expect(renderedTexts(root.root)).toContain(IN_PROGRESS_COPY);
  });

  it('renders the translated ambiguous copy under ja and keeps both controls retryable', async () => {
    await i18n.changeLanguage('ja');
    try {
      triggerSync.isError = true;
      triggerSync.error = mapSecuritySyncOperationError(new Error(SECURITY_AMBIGUOUS_MESSAGE));
      const root = renderScreen();

      expect(syncDisabledStates(root.root)).toEqual([false, false]);
      expect(renderedTexts(root.root)).toContain(i18n.t('securityAgent.mutations.ambiguous'));
      expect(renderedTexts(root.root)).not.toContain(SECURITY_AMBIGUOUS_MESSAGE);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('disables both sync controls and shows configuration-specific copy after a missing-configuration error', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error(CONFIGURATION_ERROR_MESSAGE));
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true, true]);
    expect(renderedTexts(root.root)).toContain(CONFIGURATION_COPY);
    // The raw server message is replaced by the state-specific copy.
    expect(renderedTexts(root.root)).not.toContain(CONFIGURATION_ERROR_MESSAGE);
  });

  it('disables both sync controls and shows the error copy after another non-retryable error', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error(PERSISTENCE_FAILED_MESSAGE));
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
    const syncNow = findSyncButton(root.root, 'securityAgent.dashboard.syncNow');

    act(() => {
      (syncNow.props.onPress as () => void)();
    });

    expect(triggerSync.mutate).toHaveBeenCalledWith(
      { repoFullName: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});

describe('DashboardScreen repository filter sheet', () => {
  beforeEach(() => {
    repositories.isLoading = false;
    repositories.isError = false;
    repositories.data = [];
    repositories.refetch.mockReset();
    repositories.refetch.mockResolvedValue({ isError: false });
    // handleRefresh destructures { isError } from every refetch result.
    dashboardStats.refetch.mockReset();
    dashboardStats.refetch.mockResolvedValue({ isError: false });
    lastSync.refetch.mockReset();
    lastSync.refetch.mockResolvedValue({ isError: false });
    config.data = { slaEnabled: true };
    sheet.show.mockClear();
    retryCards.cards = [];
  });

  it('opens the themed sheet with the repository options from the filter control', () => {
    const root = renderScreen();
    const filter = findFilterControl(root.root);

    act(() => {
      (filter.props.onPress as () => void)();
    });

    expect(sheet.show).toHaveBeenCalledTimes(1);
    expect(sheet.show).toHaveBeenCalledWith(
      {
        ...themedSheetOptions,
        options: ['All repositories', 'Cancel'],
        cancelButtonIndex: 1,
      },
      expect.any(Function)
    );
  });

  it('disables the filter control while repositories are loading', () => {
    repositories.isLoading = true;
    const root = renderScreen();
    const filter = findFilterControl(root.root);

    expect(filter.props.disabled).toBe(true);
  });

  it('renders a retryable card for a failed repositories fetch and retries on tap', () => {
    repositories.isError = true;
    const root = renderScreen();
    const filter = findFilterControl(root.root);

    expect(filter.props.disabled).toBe(true);
    expect(retryCards.cards).toHaveLength(1);
    expect(retryCards.cards[0]?.retryable).toBe(true);
    expect(retryCards.cards[0]?.lastError).toBe('Could not load repositories');

    act(() => {
      retryCards.cards[0]?.onRetry?.();
    });

    expect(repositories.refetch).toHaveBeenCalledTimes(1);
  });

  it('re-enables the filter control and drops the card once the refetch succeeds', () => {
    repositories.isError = true;
    renderScreen();
    expect(retryCards.cards).toHaveLength(1);

    repositories.isError = false;
    repositories.data = [{ fullName: 'kilo/repo' }];
    retryCards.cards = [];
    const root = renderScreen();
    const filter = findFilterControl(root.root);

    expect(filter.props.disabled).toBe(false);
    expect(retryCards.cards).toHaveLength(0);
  });

  it('retries the repositories query on pull-to-refresh', async () => {
    renderScreen();
    const refreshControl = tabScreen.refreshControl as ReactElement<{ onRefresh: () => void }>;

    await act(async () => {
      refreshControl.props.onRefresh();
      await Promise.resolve();
    });

    expect(repositories.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('buildLocalizedMetrics', () => {
  it('localizes every metric branch and its structured values', async () => {
    await i18n.changeLanguage('de');
    const data: Parameters<typeof buildLocalizedMetrics>[0] = {
      analysis: {
        total: 1234,
        exploitable: 2,
        needsReview: 3,
        triageComplete: 1,
        analyzing: 1,
        notAnalyzed: 1,
        failed: 1,
      },
      severity: { critical: 2, high: 3 },
      sla: {
        overall: { total: 10, withinSla: 7, overdue: 3 },
        bySeverity: { critical: { overdue: 1 }, high: { overdue: 2 } },
        dueSoon: { total: 4, exploitable: 2 },
        untrackedCount: 5,
      },
    };

    sharedMetrics.build.mockReturnValueOnce(
      ['openFindings', 'exploitable', 'needsReview', 'analysisIncomplete'].map(id =>
        dashboardMetric(id)
      )
    );
    const analysisMetrics = buildLocalizedMetrics(data, false);
    sharedMetrics.build.mockReturnValueOnce(
      ['slaCompliance', 'deadlinePassed', 'dueSoon', 'noDeadline'].map(id => dashboardMetric(id))
    );
    const slaMetrics = buildLocalizedMetrics(data, true);

    expect([...analysisMetrics, ...slaMetrics].map(item => item.id)).toEqual([
      'openFindings',
      'exploitable',
      'needsReview',
      'analysisIncomplete',
      'slaCompliance',
      'deadlinePassed',
      'dueSoon',
      'noDeadline',
    ]);
    expect(analysisMetrics[0]?.value).toBe('1.234');
    expect(slaMetrics[0]?.value).toMatch(/^70[\s\u00A0\u202F]*%$/);
    expect(analysisMetrics.every(item => item.label.length > 0 && item.detail.length > 0)).toBe(
      true
    );
    expect(slaMetrics.every(item => item.label.length > 0 && item.detail.length > 0)).toBe(true);
    await i18n.changeLanguage('en');
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

describe('DashboardScreen pending stats', () => {
  const resolvedData = {
    analysis: {
      total: 3,
      exploitable: 0,
      needsReview: 1,
      triageComplete: 0,
      analyzing: 0,
      notAnalyzed: 0,
      failed: 0,
    },
    severity: { critical: 1, high: 1 },
    sla: {
      overall: { total: 0, withinSla: 0, overdue: 0 },
      bySeverity: { critical: { overdue: 0 }, high: { overdue: 0 } },
      dueSoon: { total: 0, exploitable: 0 },
      untrackedCount: 0,
    },
  };

  it('paints the metric skeleton while a paused stats read is still pending', () => {
    // A NetInfo-paused read is pending without fetching, so `isLoading` is
    // false. The body must still show its loading state instead of an empty
    // metrics row.
    dashboardStats.isPending = true;
    dashboardStats.isLoading = false;
    dashboardStats.data = undefined;
    sharedMetrics.build.mockReturnValue([dashboardMetric('openFindings')]);

    const root = renderScreen();

    expect(
      root.root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Skeleton')
    ).toHaveLength(4);
    expect(renderedTexts(root.root)).not.toContain(
      i18n.t('securityAgent.dashboardMetrics.openFindings')
    );
  });

  it('replaces the skeleton with the metric once the read resolves', () => {
    dashboardStats.isPending = false;
    dashboardStats.isLoading = false;
    dashboardStats.data = resolvedData;
    sharedMetrics.build.mockReturnValue([dashboardMetric('openFindings')]);

    const root = renderScreen();

    expect(
      root.root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Skeleton')
    ).toHaveLength(0);
    expect(renderedTexts(root.root)).toContain(
      i18n.t('securityAgent.dashboardMetrics.openFindings')
    );
  });
});
