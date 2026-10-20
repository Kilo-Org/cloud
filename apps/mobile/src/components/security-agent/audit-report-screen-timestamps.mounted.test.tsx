// The report's period is labelled UTC, so every timestamp it carries names its
// zone and clock; a system or masked actor is labelled in the app language,
// while a named user keeps the name the server recorded.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AuditReportScreen } from './audit-report-screen';

const personalQueryOptions = vi.hoisted(() => vi.fn());
const orgQueryOptions = vi.hoisted(() => vi.fn());
const useQuery = vi.hoisted(() => vi.fn());
const formatDate = vi.hoisted(() => vi.fn(String));

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
  formatDate,
  formatNumber: String,
}));
vi.mock('@/lib/utils', () => ({
  capitalize: (value: string) => value,
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

const EVENT = {
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
};

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
  events: [EVENT],
};

function makeReport(findings: unknown[] = [FINDING]) {
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
      findingCount: findings.length,
      activityCount: 1,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
      byAction: {},
    },
    findings,
  };
}

let mounted: R | undefined = undefined;

function renderReport(findings: unknown[] = [FINDING]): I {
  useQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    isPending: false,
    isPaused: false,
    error: null,
    refetch: vi.fn(),
    data: { status: 'ok', report: makeReport(findings) },
  });
  act(() => {
    mounted = TestRenderer.create(createElement(AuditReportScreen, { scope: 'personal' }));
  });
  if (!mounted) {
    throw new Error('renderer was not created');
  }
  return mounted.root;
}

function renderedText(root: I): string[] {
  const texts = root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Text'
  );
  return texts
    .map(node => {
      const children: unknown[] = Array.isArray(node.props.children)
        ? node.props.children
        : [node.props.children];
      return children.filter((child): child is string => typeof child === 'string').join('');
    })
    .filter(value => value.length > 0);
}

function eventWithActor(id: string, actor: Record<string, unknown>) {
  return { ...EVENT, id, actor };
}

describe('AuditReportScreen timestamps and actor labels', () => {
  beforeEach(() => {
    personalQueryOptions.mockClear();
    orgQueryOptions.mockClear();
    useQuery.mockReset();
    formatDate.mockClear();
  });

  afterEach(async () => {
    act(() => mounted?.unmount());
    mounted = undefined;
    await i18n.changeLanguage('en');
  });

  it('shows the generation clock and an explicit UTC marker', () => {
    const root = renderReport();

    expect(formatDate).toHaveBeenCalledWith('2026-01-02T00:00:00.000Z', expect.any(String), {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(renderedText(root)).toContain(
      i18n.t('securityAgent.auditReport.generated', {
        generatedAt: '2026-01-02T00:00:00.000Z UTC',
      })
    );
  });

  it('labels the event actor in the app language and keeps a named user verbatim', async () => {
    await i18n.changeLanguage('de');
    const root = renderReport([
      {
        ...FINDING,
        events: [
          eventWithActor('system', {
            type: 'system',
            displayName: 'Kilo system',
            masked: false,
          }),
          eventWithActor('admin', {
            type: 'user',
            id: '00000000-0000-0000-0000-000000000000',
            displayName: 'Kilo Admin',
            masked: true,
            maskedKind: 'kilo_admin',
          }),
          // A response that predates `maskedKind` still gets a localized label.
          eventWithActor('masked', {
            type: 'user',
            id: '00000000-0000-0000-0000-000000000000',
            displayName: 'Masked user',
            masked: true,
          }),
          eventWithActor('named', {
            type: 'user',
            id: 'customer-user',
            displayName: 'Ada Lovelace',
            masked: false,
          }),
        ],
      },
    ]);

    const prefix = '2026-01-01T00:00:00.000Z UTC · ';
    expect(renderedText(root).filter(line => line.startsWith(prefix))).toEqual([
      `${prefix}${i18n.t('securityAgent.auditReport.actorSystem')}`,
      `${prefix}${i18n.t('securityAgent.auditReport.actorMaskedKiloAdmin')}`,
      `${prefix}${i18n.t('securityAgent.auditReport.actorMaskedUser')}`,
      `${prefix}Ada Lovelace`,
    ]);
  });
});
