import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { type BriefingReport } from '@/lib/agent-briefing';
import { act, TestRenderer } from '@/test/renderer';
import { BriefingDetailScreen } from './briefing-detail-screen';

const state = vi.hoisted(() => ({
  report: undefined as BriefingReport | undefined,
  isPending: false,
  isError: false,
  error: undefined as unknown,
  offline: false,
  options: undefined as
    | undefined
    | {
        refetchInterval: (query: { state: { data?: BriefingReport } }) => number | false;
      },
  timestamp: vi.fn(() => 'formatted source time'),
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ 'report-id': 'report-1' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: typeof state.options) => {
    state.options = options;
    return {
      data: state.report,
      isPending: state.isPending,
      isError: state.isError,
      error: state.error,
      refetch: vi.fn(),
    };
  },
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ removeQueries: vi.fn() }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/agent-briefing', () => ({
  BRIEFING_PATH: '/(app)/agent-briefing',
  useBriefingAccess: () => ({ enabled: true, canRead: () => true }),
  useBriefingDismissals: () => ({ dismiss: vi.fn() }),
  useBriefingInvalidation: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      get: { queryOptions: () => ({}), queryKey: () => [] },
      read: { mutationOptions: () => ({}) },
    },
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => state.offline,
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ setOrganizationId: vi.fn() }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('./briefing-card', () => ({ BriefingScorecard: 'Scorecard' }));
vi.mock('./briefing-period-label', () => ({ BriefingPeriodLabel: 'PeriodLabel' }));
vi.mock('./briefing-session-list', () => ({ BriefingSessionList: 'SessionList' }));
vi.mock('./briefing-summary', () => ({ BriefingSummary: 'Summary' }));
vi.mock('./briefing-window', () => ({ formatBriefingTimestamp: state.timestamp }));
vi.mock('./briefing-session-href', () => ({ briefingSourceHref: () => '/session' }));

const report: BriefingReport = {
  id: 'report-1',
  createdAt: '2026-10-28T08:00:00Z',
  capturedAt: '2026-10-28T08:00:00Z',
  truncated: false,
  timezone: 'Europe/Berlin',
  localDate: '2026-10-28',
  context: { id: 'personal', organizationId: null, name: 'Personal' },
  nightStartAt: '2026-10-27T22:00:00Z',
  cutoffAt: '2026-10-28T08:00:00Z',
  morningEndAt: '2026-10-28T12:00:00Z',
  publishedAt: '2026-10-28T08:00:00Z',
  updatedAt: '2026-10-28T08:00:00Z',
  expiresAt: '2026-10-28T12:00:00Z',
  readAt: '2026-10-28T09:00:00Z',
  dismissedAt: null,
  scorecard: { sessions: 0, pullRequests: 0, blockers: 0 },
  coverage: { activity: 'partial', pullRequests: 'partial', blockers: 'partial' },
  sessions: [],
  sources: [],
  summary: {
    status: 'unavailable',
    text: null,
    model: null,
    costMicrodollars: 0,
    chargeStatus: 'settled',
    estimatedCostMicrodollars: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  },
};
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
beforeEach(() => {
  state.report = report;
  state.isPending = false;
  state.isError = false;
  state.error = undefined;
  state.offline = false;
  state.options = undefined;
  vi.clearAllMocks();
});
afterEach(() => act(() => renderer?.unmount()));
function mount() {
  act(() => {
    renderer = TestRenderer.create(createElement(BriefingDetailScreen));
  });
  if (!renderer) {
    throw new Error('Detail screen did not mount');
  }
  return renderer;
}

it('explains a quiet snapshot without rendering an AI error or empty evidence sections', () => {
  const mounted = mount();
  expect(
    mounted.root.findAllByType('Text' as ElementType).map(node => node.props.children)
  ).toContain('agentBriefing.quietSnapshot');
  expect(mounted.root.findAllByType('Summary' as ElementType)).toHaveLength(0);
  expect(mounted.root.findAllByType('SessionList' as ElementType)).toHaveLength(0);
});

it('polls only until the captured snapshot summary reaches a terminal status', () => {
  mount();
  const interval = state.options?.refetchInterval;
  if (!interval) {
    throw new Error('Query interval was not configured');
  }
  for (const status of [
    'pending',
    'running',
    'ready',
    'failed',
    'unavailable',
    'disabled',
  ] as const) {
    expect(
      interval({ state: { data: { ...report, summary: { ...report.summary, status } } } })
    ).toBe(status === 'pending' || status === 'running' ? 15_000 : false);
  }
});

it('uses the frozen report timezone and a localized artifact heading for readable metadata', () => {
  const source: BriefingReport['sources'][number] = {
    id: 'metadata:session',
    sessionId: 'session',
    kind: 'artifact',
    title: 'Captured session metadata',
    excerpt: 'Plan: one step remaining.\n\nChanges: updated files.',
    url: '/cloud/sessions/session',
    occurredAt: '2026-10-28T07:00:00Z',
  };
  state.report = {
    ...report,
    scorecard: { sessions: 1, pullRequests: 0, blockers: 0 },
    sources: [source],
    sessions: [
      { sessionId: 'session', title: 'Session', url: source.url, status: null, sources: [source] },
    ],
  };
  const mounted = mount();
  expect(state.timestamp).toHaveBeenCalledWith('2026-10-28T07:00:00Z', 'en', 'Europe/Berlin');
  const texts = mounted.root.findAllByType('Text' as ElementType).map(node => node.props.children);
  expect(texts).toContain('agentBriefing.sourceMetadata');
  expect(texts).toContain('Plan: one step remaining.\n\nChanges: updated files.');
  expect(texts).not.toContain('Captured session metadata');
});

it('says it is offline, not a load failure, while the first read is paused', () => {
  // Paused offline, the read never settles: the skeleton and the failure both
  // describe a fetch that has not started, so connectivity names the state.
  state.report = undefined;
  state.isPending = true;
  state.offline = true;
  const mounted = mount();

  const errors = mounted.root.findAllByType('QueryError' as ElementType);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.props).toMatchObject({ variant: 'offline' });
  expect(errors[0]?.props.onRetry).toBeUndefined();
  expect(errors[0]?.props.title).toBe('offline.noInternet');
  expect(mounted.root.findAllByType('Skeleton' as ElementType)).toHaveLength(0);
});

it('renders a rejected read as a permission state with no retry', () => {
  state.report = undefined;
  state.isError = true;
  state.error = { data: { code: 'FORBIDDEN' } };
  const mounted = mount();

  const errors = mounted.root.findAllByType('QueryError' as ElementType);
  expect(errors).toHaveLength(1);
  // Retrying a rejected read returns the same rejection, so the state offers none.
  expect(errors[0]?.props).toMatchObject({ variant: 'permission' });
  expect(errors[0]?.props.onRetry).toBeUndefined();
  // The variant's own copy names the denial; the screen adds no title of its own.
  expect(errors[0]?.props.title).toBeUndefined();
});
