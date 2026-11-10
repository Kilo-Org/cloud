// Audit-report evidence contract: an expanded finding shows the reason and the
// confidence its events recorded, and every summary figure is one accessible
// element whose label reads the count with what it counts.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));
vi.mock('@/lib/format', () => ({
  formatCalendarDate: String,
  formatDate: String,
  formatNumber: String,
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
  TabScreenScrollView: 'TabScreenScrollView',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function auditEvent(overrides: Record<string, unknown>) {
  return {
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
    ...overrides,
  };
}

const FINDING = {
  findingId: 'f1',
  source: 'dependabot',
  sourceId: null,
  repository: 'org/repo',
  title: 'Prototype pollution in minimist',
  severity: 'critical',
  status: 'ignored',
  packageName: 'minimist',
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
    auditEvent({}),
    auditEvent({
      id: 'e2',
      action: 'security.finding.analysis_completed',
      label: 'Analysis completed',
      afterState: { analysis_status: 'completed', confidence: 'medium' },
    }),
    auditEvent({
      id: 'e3',
      action: 'security.finding.auto_dismissed',
      label: 'Auto dismissed',
      afterState: { status: 'ignored', reason_code: 'not_used' },
      metadata: { reason_code: 'not_used', confidence: 'high' },
    }),
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
      activityCount: 26,
      bySeverity: { critical: 2, high: 4, medium: 4, low: 2 },
      byAction: {},
    },
    findings: [FINDING],
    ...overrides,
  };
}

let mounted: R | undefined = undefined;

function renderScreen(): R {
  act(() => {
    mounted = TestRenderer.create(createElement(AuditReportScreen, { scope: 'personal' }));
  });
  const r = mounted;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function hostNodes(root: I, type: string): I[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === type);
}

function textStrings(root: I): string[] {
  return hostNodes(root, 'Text')
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

function summaryLabels(root: I): (string | undefined)[] {
  return hostNodes(root, 'View')
    .filter(node => node.props.accessible === true)
    .map(node => node.props.accessibilityLabel);
}

beforeEach(() => {
  useQuery.mockReset();
  useQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    isPending: false,
    isPaused: false,
    error: null,
    data: { status: 'ok', report: makeReport() },
    refetch: vi.fn(),
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
});

describe('AuditReportScreen evidence', () => {
  it('shows the reason and the confidence an auto-dismissal recorded', () => {
    const root = renderScreen();
    const strings = textStrings(root.root);

    expect(strings).toContain('Reason: Vulnerable code is not used');
    expect(strings).toContain('Confidence: High');
  });

  it('shows the confidence a finished analysis recorded', () => {
    const root = renderScreen();

    expect(textStrings(root.root)).toContain('Confidence: Medium');
  });

  it('reads each summary figure as one element with its count and label', () => {
    const root = renderScreen();

    expect(summaryLabels(root.root)).toEqual([
      '1 finding',
      '26 events',
      '2 Critical',
      '4 High',
      '4 Medium',
      '2 Low',
    ]);
  });

  it('uses the plural form for a count above one', () => {
    useQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      isPending: false,
      isPaused: false,
      error: null,
      data: {
        status: 'ok',
        report: makeReport({
          summary: {
            findingCount: 12,
            activityCount: 1,
            bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
            byAction: {},
          },
        }),
      },
      refetch: vi.fn(),
    });

    const root = renderScreen();

    expect(summaryLabels(root.root).slice(0, 2)).toEqual(['12 findings', '1 event']);
  });
});
