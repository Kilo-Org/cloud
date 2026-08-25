/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. */

// Audit-report screen state contract: loading shows a skeleton; a network
// error and a `query_failed` response are retryable (inline error + Retry);
// the org billing-gate denial (FORBIDDEN/UNAUTHORIZED) is non-retryable with
// an explanation and no Retry; an empty period shows EmptyState. The screen
// branches personal vs. org on the tRPC procedure, mirroring
// use-security-agent.ts.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AuditReportScreen } from './audit-report-screen';

const personalQueryOptions = vi.hoisted(() => vi.fn());
const orgQueryOptions = vi.hoisted(() => vi.fn());
const useQuery = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
}));
vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  ShieldOff: 'ShieldOff',
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    securityAgent: { getAuditReport: { queryOptions: personalQueryOptions } },
    organizations: { securityAgent: { getAuditReport: { queryOptions: orgQueryOptions } } },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery,
}));
// Faithful mirror of the real classifier (covered by its own suite): only the
// literal 'personal' scope is personal.
vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));
vi.mock('@/lib/format', () => ({
  formatDate: String,
}));
vi.mock('@/lib/utils', () => ({
  capitalize: (value: string) => value.charAt(0).toUpperCase() + value.slice(1),
  parseTimestamp: (value: unknown) => value,
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: 'CollapsibleSection',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

const FINDING = {
  findingId: 'f1',
  source: 'dependabot',
  sourceId: null,
  repository: 'org/repo',
  title: 'Prototype pollution in lodash',
  severity: 'high',
  status: 'open',
  packageName: 'lodash',
  packageEcosystem: 'npm',
  manifestPath: 'package.json',
  patchedVersion: null,
  ghsaId: null,
  cveId: null,
  cweIds: [],
  cvssScore: null,
  dependabotUrl: null,
  firstDetectedAt: '2026-01-01T00:00:00.000Z',
  canonicalFindingId: null,
  deleted: false,
  sla: { status: 'unknown', deadline: null, reason: 'missing_recorded_deadline' },
  hasLegacySupplementalActivity: false,
  events: [
    {
      id: 'e1',
      action: 'security.finding.created',
      label: 'Imported',
      occurredAt: '2026-01-01T00:00:00.000Z',
      sourceOccurredAt: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
      actor: { type: 'system', displayName: 'Kilo system', masked: false },
      beforeState: null,
      afterState: null,
      metadata: null,
      legacySupplemental: false,
    },
  ],
};

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    reportVersion: 1,
    owner: { type: 'user', id: 'u1', displayName: 'Personal owner' },
    period: {
      start: '2026-01-01T00:00:00.000Z',
      endExclusive: '2026-01-02T00:00:00.000Z',
      displayEnd: '2026-01-01',
      timeZone: 'UTC',
    },
    generatedAt: '2026-01-02T00:00:00.000Z',
    dataThrough: '2026-01-02T00:00:00.000Z',
    reliableCoverageStart: '2025-01-01T00:00:00.000Z',
    evidenceBasis: 'recorded_by_kilo',
    hasLegacySupplementalActivity: false,
    summary: {
      findingCount: 1,
      activityCount: 1,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
      byAction: {},
    },
    findings: [FINDING],
    ...overrides,
  };
}

function setQueryState(state: {
  isLoading?: boolean;
  isError?: boolean;
  isPending?: boolean;
  isPaused?: boolean;
  error?: unknown;
  data?: unknown;
}) {
  useQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    isPending: false,
    isPaused: false,
    error: null,
    data: undefined,
    refetch: vi.fn(),
    ...state,
  });
}

function renderScreen(scope: string): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(AuditReportScreen, { scope }));
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function findByType(root: I, type: string): I[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === type);
}

function isInstance(child: I | string): child is I {
  return typeof child !== 'string';
}

// The renderer keeps the top function component as `root.root`; its first
// child is the screen's root View, whose first child must be the header.
function firstChildTypeOfScreenRoot(root: I): string | undefined {
  const screenView = root.children.find(isInstance);
  const first = screenView?.children.find(isInstance);
  if (!first) {
    return undefined;
  }
  const type = first.type;
  return typeof type === 'string' ? type : undefined;
}

function useQueryEnabledFlags(): boolean[] {
  return useQuery.mock.calls.map(call => (call[0] as { enabled?: boolean }).enabled === true);
}

describe('AuditReportScreen states', () => {
  beforeEach(() => {
    personalQueryOptions.mockClear();
    orgQueryOptions.mockClear();
    useQuery.mockClear();
    useQuery.mockReset();
  });

  it('renders the ScreenHeader as the first child', () => {
    setQueryState({ isLoading: true });
    const root = renderScreen('personal');

    expect(firstChildTypeOfScreenRoot(root.root)).toBe('ScreenHeader');
  });

  it('renders a skeleton while loading', () => {
    setQueryState({ isLoading: true });
    const root = renderScreen('personal');

    expect(findByType(root.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it('renders a retryable error with Retry on a network failure', () => {
    setQueryState({ isError: true, error: { data: { code: 'INTERNAL_SERVER_ERROR' } } });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('Could not load the audit report');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
  });

  it('maps query_failed to a retryable error, not empty', () => {
    setQueryState({
      data: { status: 'query_failed', message: 'Report query did not finish' },
    });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('Report query did not finish. Try again.');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it('renders a retryable offline error on a paused initial fetch', () => {
    setQueryState({ isPending: true, isPaused: true });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('offline');
    expect(errors[0]?.props.message).toBe('Check your connection and try again.');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
    expect(findByType(root.root, 'Skeleton')).toHaveLength(0);
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it('renders a non-retryable explanation without Retry on FORBIDDEN', () => {
    setQueryState({ isError: true, error: { data: { code: 'FORBIDDEN' } } });
    const root = renderScreen('org-123');

    const empty = findByType(root.root, 'EmptyState');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.props.title).toBe('Audit report unavailable');
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
  });

  it('treats the org billing-gate UNAUTHORIZED denial as non-retryable too', () => {
    setQueryState({ isError: true, error: { data: { code: 'UNAUTHORIZED' } } });
    const root = renderScreen('org-123');

    const empty = findByType(root.root, 'EmptyState');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.props.title).toBe('Audit report unavailable');
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
  });

  it('treats a personal UNAUTHORIZED as a retryable session error', () => {
    setQueryState({ isError: true, error: { data: { code: 'UNAUTHORIZED' } } });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('Could not load the audit report');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it('renders EmptyState for an empty period', () => {
    setQueryState({
      data: {
        status: 'ok',
        report: makeReport({ findings: [], summary: { findingCount: 0, activityCount: 0 } }),
      },
    });
    const root = renderScreen('personal');

    const empty = findByType(root.root, 'EmptyState');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.props.title).toBe('No recorded activity');
  });

  it('renders one section per finding group for a non-empty report', () => {
    setQueryState({ data: { status: 'ok', report: makeReport() } });
    const root = renderScreen('personal');

    expect(findByType(root.root, 'CollapsibleSection')).toHaveLength(1);
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
  });
});

describe('AuditReportScreen personal/org branching', () => {
  beforeEach(() => {
    personalQueryOptions.mockClear();
    orgQueryOptions.mockClear();
    useQuery.mockClear();
    useQuery.mockReset();
  });

  it('calls the personal procedure (enabled) for the personal scope', () => {
    setQueryState({ isLoading: true });
    renderScreen('personal');

    expect(personalQueryOptions).toHaveBeenCalledWith({});
    expect(orgQueryOptions).toHaveBeenCalledWith({ organizationId: 'personal' });
    expect(useQueryEnabledFlags()).toEqual([true, false]);
  });

  it('calls the org procedure (enabled) for an organization scope', () => {
    setQueryState({ isLoading: true });
    renderScreen('org-123');

    expect(personalQueryOptions).toHaveBeenCalledWith({});
    expect(orgQueryOptions).toHaveBeenCalledWith({ organizationId: 'org-123' });
    expect(useQueryEnabledFlags()).toEqual([false, true]);
  });
});
