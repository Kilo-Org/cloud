// Test support for audit-report-screen.mounted.test.tsx and
// audit-report-screen.report.mounted.test.tsx: the module-mock harness, the
// report fixture, and the render/query helpers. The vi.mock registrations in
// this module body run while it is evaluated — which is why the test files
// must import this module FIRST, before the screen or any other module that
// has to resolve against these mocks.
//
// Audit-report screen contract: loading shows a skeleton; a network error and
// a `query_failed` response are retryable (inline error + Retry); the org
// billing-gate denial (FORBIDDEN/UNAUTHORIZED) is non-retryable with an
// explanation and no Retry; an empty period shows EmptyState. The screen
// branches personal vs. org on the tRPC procedure, mirroring
// use-security-agent.ts.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

import '@/i18n';
import { AuditReportScreen } from './audit-report-screen';

const hoisted = vi.hoisted(() => ({
  personalQueryOptions: vi.fn(),
  orgQueryOptions: vi.fn(),
  useQuery: vi.fn(),
}));

export const personalQueryOptions = hoisted.personalQueryOptions;
export const orgQueryOptions = hoisted.orgQueryOptions;
const useQuery = hoisted.useQuery;

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
vi.mock('@tanstack/react-query', () => ({ useQuery: hoisted.useQuery }));
// Faithful mirror of the real classifier (covered by its own suite): only the
// literal 'personal' scope is personal.
vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));
vi.mock('@/lib/format', () => ({
  formatCalendarDate: String,
  formatDate: String,
  formatNumber: String,
}));
vi.mock('@/lib/utils', () => ({
  capitalize: (value: string) => value.charAt(0).toLocaleUpperCase() + value.slice(1),
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  parseTimestamp: (value: unknown) => value,
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  // The real section resolves a function child inside its expanded branch; this
  // suite renders that body (host element kept, so findByType still sees it).
  CollapsibleSection: (props: { children: ReactNode | (() => ReactNode); title: string }) =>
    createElement(
      'CollapsibleSection',
      { title: props.title },
      typeof props.children === 'function' ? props.children() : props.children
    ),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'TabScreenScrollView',
}));

export type R = TestRenderer.ReactTestRenderer;
export type I = TestRenderer.ReactTestInstance;

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

export function makeReport(overrides: Record<string, unknown> = {}) {
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

export function setQueryState(state: {
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

export function renderScreen(scope: string): R {
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

export function findByType(root: I, type: string): I[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === type);
}

function isInstance(child: I | string): child is I {
  return typeof child !== 'string';
}

// The renderer keeps the top function component as `root.root`; its first
// child is the screen's root View, whose first child must be the header.
export function firstChildTypeOfScreenRoot(root: I): string | undefined {
  const screenView = root.children.find(isInstance);
  const first = screenView?.children.find(isInstance);
  return first && typeof first.type === 'string' ? first.type : undefined;
}

export function useQueryEnabledFlags(): boolean[] {
  return useQuery.mock.calls.map(call => {
    const options: unknown = call[0];
    return typeof options === 'object' && options !== null && 'enabled' in options
      ? options.enabled === true
      : false;
  });
}

export function resetQueryMocks(): void {
  personalQueryOptions.mockClear();
  orgQueryOptions.mockClear();
  useQuery.mockClear();
  useQuery.mockReset();
}
