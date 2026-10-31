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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  mapSecuritySyncOperationError,
  SECURITY_AMBIGUOUS_MESSAGE,
  SECURITY_SERVICE_UNAVAILABLE_MESSAGE,
} from '@/lib/security-agent-ledger';
import { buildLocalizedMetrics, DashboardScreen } from './dashboard-screen';

// The security mutation hooks hoist an operation key through
// `@/lib/operation-key`, whose expo-crypto root import loads a native binding
// this node project does not have.
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
  data: undefined as { lastSyncTime?: string | null } | undefined,
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
  status: 'allowed' as 'loading' | 'error' | 'denied' | 'allowed',
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const settingsRecovery = vi.hoisted(() => ({
  retry: vi.fn(),
  isRetrying: false,
}));
const recoveryStatus = vi.hoisted(() => ({
  renders: [] as { message?: string; isRetrying: boolean; onRetry: () => void }[],
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

// Captures the dashboard-sections props, so a test can assert the stats payload
// a failure leaves on screen.
const sectionsProps = vi.hoisted(() => ({
  props: [] as { data?: unknown; slaEnabled?: boolean; neverSynced?: boolean }[],
}));

// Captures the empty state the dashboard renders before the first sync.
const emptyState = vi.hoisted(() => ({
  props: [] as { title: string; action?: ReactElement }[],
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
  useRetrySecurityAgentSettings: () => settingsRecovery,
}));
vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissFailures: () => dismissFailures,
  securityDismissFailureCopy: (draft: { lastError: string }) => draft.lastError,
}));
vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outbox,
}));
vi.mock('@/components/security-agent/settings-recovery-status', () => ({
  SettingsRecoveryStatus: (props: {
    message?: string;
    isRetrying: boolean;
    onRetry: () => void;
  }) => {
    recoveryStatus.renders.push(props);
    return null;
  },
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
// The header the dashboard paints: its title names the scope, the eyebrow the
// product. Captured per render so a test can assert what a reader reads.
const headers = vi.hoisted(() => ({
  props: [] as { title?: string; eyebrow?: string }[],
}));
// The shared membership list the scope title resolves from. The title never
// fetches it, so the mock only needs the cache key it reads.
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; eyebrow?: string }) => {
    headers.props.push(props);
    return null;
  },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: {
        queryOptions: () => ({ queryKey: ['organizations', 'list'] }),
      },
    },
  }),
}));
vi.mock('@/components/query-error', () => ({ QueryError: () => null }));
vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: () => null,
}));
vi.mock('@/components/security-agent/dashboard-sections', () => ({
  DashboardSections: (props: { data?: unknown; slaEnabled?: boolean; neverSynced?: boolean }) => {
    sectionsProps.props.push(props);
    return null;
  },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
// The empty state is a layout component with its own suite; this suite asserts
// when the dashboard reaches for it and what it offers.
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; action?: ReactElement }) => {
    emptyState.props.push(props);
    return props.action ?? null;
  },
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

function renderScreen(scope = 'personal', memberships?: unknown[]): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(dashboardTree(scope, memberships));
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

/** The dashboard inside the provider stack it needs, for a first render or an update. */
function dashboardTree(scope = 'personal', memberships?: unknown[]): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  if (memberships) {
    // The app-wide membership list the scope title reads, already cached.
    queryClient.setQueryData(['organizations', 'list'], memberships);
  }
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(DashboardScreen, { scope })
  );
}

function syncButtons(root: I): I[] {
  const syncNow = i18n.t('securityAgent.dashboard.syncNow');
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityLabel === syncNow
  );
}

function findSyncButton(root: I): I {
  const label = i18n.t('securityAgent.dashboard.syncNow');
  const n = syncButtons(root)[0];
  if (!n) {
    throw new Error(`expected 1 ${label} button, got 0`);
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

// The one Button the dashboard renders on its own: the retry beside a failed
// sync's copy. Every other failure renders through the shared retry card.
function syncRetries(root: I): I[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button');
}

function pressSyncRetry(root: I): void {
  const retry = syncRetries(root)[0];
  if (!retry) {
    throw new Error('no sync retry control rendered');
  }
  act(() => {
    (retry.props.onPress as () => void)();
  });
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

describe('DashboardScreen names the scope it acts on', () => {
  // The dashboard is the enabled landing of one scope. An admin in several
  // organizations reads whose agent — and whose GitHub app — this one is.
  it('names the organization the dashboard belongs to', () => {
    headers.props = [];
    renderScreen('org_123', [
      { organizationId: 'org_123', organizationName: 'Drain Labs', role: 'owner' },
    ]);
    const header = headers.props.at(-1);
    expect(header?.title).toBe('Drain Labs');
    expect(header?.eyebrow).toBe('Security Agent');
  });

  it('names the personal scope', () => {
    headers.props = [];
    renderScreen('personal');
    const header = headers.props.at(-1);
    expect(header?.title).toBe('Personal');
    expect(header?.eyebrow).toBe('Security Agent');
  });

  it('keeps the header line while the membership list loads', () => {
    headers.props = [];
    renderScreen('org_123');
    const header = headers.props.at(-1);
    expect(header?.title).toBe('Organization');
    expect(header?.eyebrow).toBe('Security Agent');
  });
});

describe('DashboardScreen before the first sync', () => {
  beforeEach(() => {
    dashboardStats.isPending = false;
    dashboardStats.isError = false;
    dashboardStats.data = { sla: { overall: { total: 0 } }, analysis: { total: 0 } };
    sharedMetrics.build.mockReturnValue([]);
  });

  // The stored absence of a sync is what paints "Not yet synced" under the
  // filter. The sections must read that same fact, or an organization that has
  // never run the agent reports an all-clear it never measured. A scope with
  // findings keeps its sections: only an empty grid gives way to the prompt.
  it('tells the sections nothing has been synced yet', () => {
    sectionsProps.props = [];
    lastSync.data = { lastSyncTime: null };
    dashboardStats.data = { sla: { overall: { total: 2 } }, analysis: { total: 2 } };
    renderScreen('org_123');
    expect(sectionsProps.props.at(-1)?.neverSynced).toBe(true);
  });

  it('leaves a synced scope measured', () => {
    sectionsProps.props = [];
    lastSync.data = { lastSyncTime: '2026-10-30T12:00:00.000Z' };
    renderScreen('org_123');
    expect(sectionsProps.props.at(-1)?.neverSynced).toBe(false);
  });
});

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

  it('keeps the sync control enabled in the happy state', () => {
    const root = renderScreen();

    expect(syncButtons(root.root)).toHaveLength(1);
    expect(syncDisabledStates(root.root)).toEqual([false]);
  });

  it('keeps the sync control enabled after a retryable error and shows its copy', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error('operation_in_progress'));
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([false]);
    expect(renderedTexts(root.root)).toContain(IN_PROGRESS_COPY);
  });

  it('renders the translated ambiguous copy under ja and keeps the control retryable', async () => {
    await i18n.changeLanguage('ja');
    try {
      triggerSync.isError = true;
      triggerSync.error = mapSecuritySyncOperationError(new Error(SECURITY_AMBIGUOUS_MESSAGE));
      const root = renderScreen();

      expect(syncDisabledStates(root.root)).toEqual([false]);
      expect(renderedTexts(root.root)).toContain(i18n.t('securityAgent.mutations.ambiguous'));
      expect(renderedTexts(root.root)).not.toContain(SECURITY_AMBIGUOUS_MESSAGE);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('disables the sync control and shows configuration-specific copy after a missing-configuration error', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error(CONFIGURATION_ERROR_MESSAGE));
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true]);
    expect(renderedTexts(root.root)).toContain(CONFIGURATION_COPY);
    // The raw server message is replaced by the state-specific copy.
    expect(renderedTexts(root.root)).not.toContain(CONFIGURATION_ERROR_MESSAGE);
  });

  it('disables the sync control and shows the error copy after another non-retryable error', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error(PERSISTENCE_FAILED_MESSAGE));
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true]);
    expect(renderedTexts(root.root)).toContain(PERSISTENCE_FAILED_MESSAGE);
  });

  it('disables the sync control while a sync is pending', () => {
    triggerSync.isPending = true;
    const root = renderScreen();

    expect(syncDisabledStates(root.root)).toEqual([true]);
  });

  it('offers a retry beside a retryable failure and resubmits the current intent', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(
      new Error(SECURITY_SERVICE_UNAVAILABLE_MESSAGE)
    );
    const root = renderScreen();

    expect(syncRetries(root.root)).toHaveLength(1);
    expect(syncRetries(root.root)[0]?.props.loading).toBe(false);

    pressSyncRetry(root.root);

    expect(triggerSync.mutate).toHaveBeenCalledWith(
      { repoFullName: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('retries the intent that failed, not the filter selected since', () => {
    outbox.needsReconcile = [
      {
        operationKey: 'kilo-repo-key',
        fingerprint: 'sync:kilo/repo',
        scope: 'personal',
        input: { repoFullName: 'kilo/repo' },
      },
    ];
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(
      new Error(SECURITY_SERVICE_UNAVAILABLE_MESSAGE)
    );
    const root = renderScreen();

    act(() => {
      retryCards.cards.find(card => card.lastError === RECONCILE_COPY)?.onRetry?.();
    });
    pressSyncRetry(root.root);

    // The card's retry stored the reconcile intent; the inline retry replays it
    // rather than the (unset) repository filter the screen shows now.
    expect(triggerSync.mutate).toHaveBeenLastCalledWith(
      { repoFullName: 'kilo/repo', operationKey: 'kilo-repo-key' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('keeps the failure and reports progress on the retry while it runs', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(
      new Error(SECURITY_SERVICE_UNAVAILABLE_MESSAGE)
    );
    const root = renderScreen();
    pressSyncRetry(root.root);
    // A new attempt clears the mutation's error before it settles.
    act(() => {
      triggerSync.isError = false;
      triggerSync.isPending = true;
      triggerSync.error = null;
      root.update(dashboardTree());
    });

    expect(syncRetries(root.root)).toHaveLength(1);
    expect(syncRetries(root.root)[0]?.props.loading).toBe(true);
    expect(renderedTexts(root.root)).toContain(
      i18n.t('securityAgent.mutations.serviceUnavailable')
    );
    // The pressed control keeps its own spinner visible, and the sentence it is
    // retrying steps back so it does not read as a fresh failure.
    expect(syncRetries(root.root)[0]?.props.className).toContain('opacity-100');
    const message = root.root.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        n.props.children === i18n.t('securityAgent.mutations.serviceUnavailable')
    )[0];
    expect(message?.props.className).toContain('text-warn');
  });

  it('drops the failure row once a retry succeeds', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(
      new Error(SECURITY_SERVICE_UNAVAILABLE_MESSAGE)
    );
    const root = renderScreen();
    pressSyncRetry(root.root);
    const options = triggerSync.mutate.mock.calls.at(-1)?.[1] as { onSuccess: () => void };
    act(() => {
      triggerSync.isError = false;
      triggerSync.isPending = false;
      triggerSync.error = null;
      options.onSuccess();
      root.update(dashboardTree());
    });

    expect(syncRetries(root.root)).toHaveLength(0);
    expect(renderedTexts(root.root)).not.toContain(
      i18n.t('securityAgent.mutations.serviceUnavailable')
    );
  });

  it('offers no retry for a terminal failure', () => {
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(new Error(CONFIGURATION_ERROR_MESSAGE));
    const root = renderScreen();

    expect(syncRetries(root.root)).toHaveLength(0);
  });

  it('keeps the last risk breakdown on screen while a sync failure is shown', () => {
    const stats = { sla: { overall: { total: 3, withinSla: 2, overdue: 1 } }, analysis: {} };
    dashboardStats.data = stats;
    triggerSync.isError = true;
    triggerSync.error = mapSecuritySyncOperationError(
      new Error(SECURITY_SERVICE_UNAVAILABLE_MESSAGE)
    );
    renderScreen();

    expect(sectionsProps.props.at(-1)?.data).toBe(stats);
  });

  it('submits the sync through the header control with the current repo filter', () => {
    const root = renderScreen();
    const syncNow = findSyncButton(root.root);

    act(() => {
      (syncNow.props.onPress as () => void)();
    });

    expect(triggerSync.mutate).toHaveBeenCalledWith(
      { repoFullName: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});

describe('DashboardScreen capability recovery', () => {
  beforeEach(() => {
    capability.status = 'allowed';
    settingsRecovery.isRetrying = false;
    settingsRecovery.retry.mockClear();
    recoveryStatus.renders = [];
  });

  it('surfaces a failed role read with Retry instead of only dropping the controls', () => {
    // The entry renders this dashboard from the cached config without waiting for
    // the role read, so a manager whose read failed must be told why the audit
    // action is missing rather than reading it as lost access.
    capability.status = 'error';
    renderScreen();

    expect(recoveryStatus.renders).toHaveLength(1);
    expect(recoveryStatus.renders[0]?.message).toBe(
      i18n.t('securityAgent.settingsOverview.couldNotLoadPermissions')
    );
    act(() => recoveryStatus.renders[0]?.onRetry());
    expect(settingsRecovery.retry).toHaveBeenCalledTimes(1);
  });

  it('stays silent once the role read resolves', () => {
    renderScreen();
    expect(recoveryStatus.renders).toHaveLength(0);
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
      severity: { critical: 2, high: 3, medium: 1, low: 0 },
      sla: {
        overall: { total: 10, withinSla: 7, overdue: 5 },
        bySeverity: {
          critical: { overdue: 1 },
          high: { overdue: 2 },
          medium: { overdue: 1 },
          low: { overdue: 1 },
        },
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
    // The open-findings and overdue tiles both break the medium and low counts
    // into one bucket, so every part of the tile's number is named.
    expect(analysisMetrics[0]?.detail).toBe('2 kritisch, 3 hoch, 1 mittel und niedrig');
    expect(slaMetrics[1]?.detail).toBe('1 kritisch, 2 hoch, 2 mittel und niedrig');
    expect(slaMetrics[0]?.value).toMatch(/^70[\s\u00A0\u202F]*%$/);
    expect(analysisMetrics.every(item => item.label.length > 0 && item.detail.length > 0)).toBe(
      true
    );
    expect(slaMetrics.every(item => item.label.length > 0 && item.detail.length > 0)).toBe(true);
    await i18n.changeLanguage('en');
  });

  it('keeps the numeric slot a dash while no deadline is tracked', () => {
    const data: Parameters<typeof buildLocalizedMetrics>[0] = {
      analysis: {
        total: 0,
        exploitable: 0,
        needsReview: 0,
        triageComplete: 0,
        analyzing: 0,
        notAnalyzed: 0,
        failed: 0,
      },
      severity: { critical: 0, high: 0, medium: 0, low: 0 },
      sla: {
        overall: { total: 0, withinSla: 0, overdue: 0 },
        bySeverity: {
          critical: { overdue: 0 },
          high: { overdue: 0 },
          medium: { overdue: 0 },
          low: { overdue: 0 },
        },
        dueSoon: { total: 0, exploitable: 0 },
        untrackedCount: 0,
      },
    };

    sharedMetrics.build.mockReturnValueOnce(['slaCompliance'].map(id => dashboardMetric(id)));
    const [compliance] = buildLocalizedMetrics(data, true);

    expect(compliance?.value).toBe('—');
    expect(compliance?.detail).toBe(i18n.t('securityAgent.dashboardMetrics.noDeadlineData'));
  });

  it('reports no measurement instead of a clean result before the first sync', () => {
    const data: Parameters<typeof buildLocalizedMetrics>[0] = {
      analysis: {
        total: 0,
        exploitable: 0,
        needsReview: 0,
        triageComplete: 0,
        analyzing: 0,
        notAnalyzed: 0,
        failed: 0,
      },
      severity: { critical: 0, high: 0, medium: 0, low: 0 },
      sla: {
        overall: { total: 0, withinSla: 0, overdue: 0 },
        bySeverity: {
          critical: { overdue: 0 },
          high: { overdue: 0 },
          medium: { overdue: 0 },
          low: { overdue: 0 },
        },
        dueSoon: { total: 0, exploitable: 0 },
        untrackedCount: 0,
      },
    };

    sharedMetrics.build.mockReturnValueOnce(
      ['openFindings', 'slaCompliance', 'noDeadline'].map(id => dashboardMetric(id))
    );
    const metrics = buildLocalizedMetrics(data, true, true);

    // Zero counts and the line that read the zeros as a clean report both
    // became a dash and the screen's own not-yet-synced state.
    expect(metrics.map(metric => metric.value)).toEqual(['—', '—', '—']);
    expect(metrics.map(metric => metric.detail)).toEqual([
      i18n.t('securityAgent.dashboard.notYetSynced'),
      i18n.t('securityAgent.dashboard.notYetSynced'),
      i18n.t('securityAgent.dashboard.notYetSynced'),
    ]);
    expect(metrics.every(metric => metric.tone === 'neutral')).toBe(true);
  });

  it('omits the medium & low bucket while no medium or low finding is counted', () => {
    const data: Parameters<typeof buildLocalizedMetrics>[0] = {
      analysis: {
        total: 4,
        exploitable: 0,
        needsReview: 0,
        triageComplete: 0,
        analyzing: 0,
        notAnalyzed: 0,
        failed: 0,
      },
      severity: { critical: 2, high: 3, medium: 0, low: 0 },
      sla: {
        overall: { total: 10, withinSla: 7, overdue: 3 },
        bySeverity: {
          critical: { overdue: 1 },
          high: { overdue: 2 },
          medium: { overdue: 0 },
          low: { overdue: 0 },
        },
        dueSoon: { total: 0, exploitable: 0 },
        untrackedCount: 0,
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

    expect(analysisMetrics[0]?.detail).toBe('2 critical, 3 high');
    expect(slaMetrics[1]?.detail).toBe('1 critical, 2 high');
  });

  it('agrees a pt-BR breakdown with each of its three numbers', async () => {
    await i18n.changeLanguage('pt-BR');
    const data: Parameters<typeof buildLocalizedMetrics>[0] = {
      analysis: {
        total: 2,
        exploitable: 0,
        needsReview: 0,
        triageComplete: 0,
        analyzing: 0,
        notAnalyzed: 0,
        failed: 0,
      },
      severity: { critical: 1, high: 0, medium: 1, low: 0 },
      sla: {
        overall: { total: 2, withinSla: 0, overdue: 2 },
        bySeverity: {
          critical: { overdue: 1 },
          high: { overdue: 0 },
          medium: { overdue: 1 },
          low: { overdue: 0 },
        },
        dueSoon: { total: 0, exploitable: 0 },
        untrackedCount: 0,
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

    expect(analysisMetrics[0]?.detail).toBe('1 crítico, 0 de nível alto, 1 média/baixa');
    expect(slaMetrics[1]?.detail).toBe('1 crítico, 0 de nível alto, 1 média/baixa');
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
    severity: { critical: 1, high: 1, medium: 0, low: 0 },
    sla: {
      overall: { total: 0, withinSla: 0, overdue: 0 },
      bySeverity: {
        critical: { overdue: 0 },
        high: { overdue: 0 },
        medium: { overdue: 0 },
        low: { overdue: 0 },
      },
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

describe('DashboardScreen first-sync prompt', () => {
  const zeroStats = {
    analysis: {
      total: 0,
      exploitable: 0,
      needsReview: 0,
      triageComplete: 0,
      analyzing: 0,
      notAnalyzed: 0,
      failed: 0,
    },
    severity: { critical: 0, high: 0, medium: 0, low: 0 },
    sla: {
      overall: { total: 0, withinSla: 0, overdue: 0 },
      bySeverity: {
        critical: { overdue: 0 },
        high: { overdue: 0 },
        medium: { overdue: 0 },
        low: { overdue: 0 },
      },
      dueSoon: { total: 0, exploitable: 0 },
      untrackedCount: 0,
    },
  };

  beforeEach(() => {
    emptyState.props = [];
    sectionsProps.props = [];
    triggerSync.mutate.mockClear();
    triggerSync.isPending = false;
    triggerSync.isError = false;
    triggerSync.error = null;
    config.data = { slaEnabled: true };
    dashboardStats.isPending = false;
    dashboardStats.isLoading = false;
    dashboardStats.isError = false;
    dashboardStats.data = zeroStats;
    lastSync.isError = false;
    lastSync.data = { lastSyncTime: null };
    repositories.isError = false;
    repositories.data = [];
    sharedMetrics.build.mockReturnValue([
      dashboardMetric('openFindings'),
      dashboardMetric('slaCompliance'),
    ]);
  });

  it('replaces the zero counts and the posture sections with a first-sync prompt', () => {
    const root = renderScreen();

    // Zeroes read as a clean result, so neither the tiles nor the sections
    // render until a sync has recorded a time.
    expect(renderedTexts(root.root)).not.toContain(
      i18n.t('securityAgent.dashboardMetrics.openFindings')
    );
    expect(sectionsProps.props).toHaveLength(0);
    expect(emptyState.props).toHaveLength(1);
    expect(emptyState.props[0]?.title).toBe(i18n.t('securityAgent.dashboard.notYetSynced'));
  });

  it('states the sync status once, in the prompt, before the first sync', () => {
    // The prompt's title already says the scope has not synced, so the filter
    // row above it must not repeat the same sentence.
    const prompt = renderScreen();
    expect(renderedTexts(prompt.root)).not.toContain(
      i18n.t('securityAgent.dashboard.notYetSynced')
    );

    // Every other state keeps the row's status line.
    lastSync.data = { lastSyncTime: '2026-01-01T00:00:00.000Z' };
    const synced = renderScreen();
    expect(renderedTexts(synced.root)).toContain(
      i18n.t('securityAgent.dashboard.lastSynced', { time: 'recently' })
    );
  });

  it('starts a sync from the prompt with the current repository filter', () => {
    const root = renderScreen();
    const action = root.root.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Button' &&
        n.props.accessibilityLabel === i18n.t('securityAgent.dashboard.syncFindings')
    )[0];
    if (!action) {
      throw new Error('the first-sync prompt rendered no sync action');
    }

    act(() => {
      (action.props.onPress as () => void)();
    });

    expect(triggerSync.mutate).toHaveBeenCalledWith(
      { repoFullName: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('disables the prompt while a sync is pending', () => {
    triggerSync.isPending = true;
    const root = renderScreen();
    const action = root.root.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Button' &&
        n.props.accessibilityLabel === i18n.t('securityAgent.dashboard.syncFindings')
    )[0];

    expect(action?.props.disabled).toBe(true);
    expect(action?.props.loading).toBe(true);
  });

  it('keeps the counts once a sync time is recorded', () => {
    lastSync.data = { lastSyncTime: '2026-01-01T00:00:00.000Z' };
    const root = renderScreen();

    expect(emptyState.props).toHaveLength(0);
    expect(renderedTexts(root.root)).toContain(
      i18n.t('securityAgent.dashboardMetrics.openFindings')
    );
    expect(sectionsProps.props).toHaveLength(1);
  });

  it('keeps findings visible when the sync stamp is missing', () => {
    // A partial sync can leave findings behind with no owner-level stamp, so
    // the prompt may only replace an empty grid.
    dashboardStats.data = { ...zeroStats, analysis: { ...zeroStats.analysis, total: 3 } };
    const root = renderScreen();

    expect(emptyState.props).toHaveLength(0);
    expect(sectionsProps.props).toHaveLength(1);
    expect(renderedTexts(root.root)).toContain(
      i18n.t('securityAgent.dashboardMetrics.openFindings')
    );
  });

  it('leaves the unmeasured statement to the surfaces that report it', () => {
    // The tiles and the "Act first" row each carry the not-yet-synced line for
    // this state; the filter row must not repeat it above them.
    dashboardStats.data = { ...zeroStats, analysis: { ...zeroStats.analysis, total: 3 } };
    const root = renderScreen();
    const filterRow = root.root.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Pressable' &&
        n.props.accessibilityLabel === i18n.t('securityAgent.dashboard.filterByRepository')
    )[0];
    if (!filterRow) {
      throw new Error('the repository filter row did not render');
    }
    const lines = filterRow.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    );

    expect(sectionsProps.props.at(-1)?.neverSynced).toBe(true);
    expect(lines.map(line => line.props.children as string)).toEqual([
      i18n.t('common.allRepositories'),
    ]);
  });

  it('waits for the stats read before offering the prompt', () => {
    dashboardStats.isPending = true;
    dashboardStats.data = undefined;
    const root = renderScreen();

    expect(emptyState.props).toHaveLength(0);
    expect(
      root.root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Skeleton')
    ).toHaveLength(4);
  });

  it('offers repository setup beside the first sync', () => {
    // A sync without a configured repository answers PRECONDITION_FAILED, so
    // the pristine state cannot depend on the prompt's single action.
    const root = renderScreen();
    const manage = root.root.findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Pressable' &&
        n.props.accessibilityLabel === i18n.t('securityAgent.dashboard.manageRepositories')
    );

    expect(manage).toHaveLength(1);
  });

  it('keeps the counts while the sync-time read has not answered', () => {
    // Only a read that succeeded and reports no time proves the scope never
    // synced; a failed read has its own label and must not hide the counts.
    lastSync.data = undefined;
    lastSync.isError = true;
    const root = renderScreen();

    expect(emptyState.props).toHaveLength(0);
    expect(renderedTexts(root.root)).toContain(
      i18n.t('securityAgent.dashboardMetrics.openFindings')
    );
  });
});
