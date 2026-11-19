// Audit-report laziness contract: a collapsed finding section must not read its
// events. `FindingSection` used to build its whole body — `eventEvidenceLines`,
// `formatUtcTimestamp` and `actorLabel` — on every render, so a report whose
// sections are all closed still formatted one timestamp per event. The section
// now takes a function child, so the body is evaluated inside the expanded
// branch only.
//
// This mounts the REAL CollapsibleSection (its evidence sibling mocks it away)
// and counts `formatDate` calls carrying the per-event UTC options: the
// header's `generatedAt` is the only one while collapsed — pre-fix the count was
// one more per event — and header plus one per event once the section opens.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AuditReportScreen } from './audit-report-screen';

const personalQueryOptions = vi.hoisted(() => vi.fn());
const orgQueryOptions = vi.hoisted(() => vi.fn());
const useQuery = vi.hoisted(() => vi.fn());
const formatDateOptions = vi.hoisted(() => vi.fn<(options?: Intl.DateTimeFormatOptions) => void>());

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
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
  // The options of each call are what this suite observes, not the text.
  formatDate: (value: unknown, _locale?: string, options?: Intl.DateTimeFormatOptions) => {
    formatDateOptions(options);
    return String(value);
  },
  formatNumber: String,
}));
vi.mock('@/lib/utils', () => ({
  capitalize: (value: string) => value.charAt(0).toUpperCase() + value.slice(1),
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
  parseTimestamp: (value: unknown) => value,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
  selectReducedMotionEntrance: <T,>(reducedMotion: boolean, entrance: T) =>
    reducedMotion ? undefined : entrance,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: unknown) => ({ __timing: true, value }),
  FadeIn: { duration: (ms: number) => ({ __fadeIn: ms }) },
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'TabScreenScrollView',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

/** The options `formatUtcTimestamp` passes; the report period's own call does not match. */
const EVENT_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

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
    auditEvent({
      id: 'e4',
      action: 'security.finding.status_change',
      label: 'Status changed',
      beforeState: { status: 'open' },
      afterState: { status: 'fixed' },
    }),
    auditEvent({
      id: 'e5',
      action: 'security.finding.severity_changed',
      label: 'Severity changed',
      beforeState: { severity: 'critical' },
      afterState: { severity: 'high' },
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

function press(root: I, accessibilityLabel: string) {
  const [control] = root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === accessibilityLabel
  );
  if (!control) {
    throw new Error(`no control labelled ${accessibilityLabel}`);
  }
  act(() => {
    (control.props.onPress as () => void)();
  });
}

function textStrings(root: I): string[] {
  return (
    root
      // The host-node names this suite mocks in are not part of React's own tag
      // union, so the check compares the runtime string, like the sibling suites.
      .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
      .map(node => node.props.children)
      .filter((child): child is string => typeof child === 'string')
  );
}

function hasEventTimestampOptions(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) {
    return false;
  }
  return Object.entries(EVENT_TIMESTAMP_OPTIONS).every(
    ([key, expected]) => (options as Record<string, unknown>)[key] === expected
  );
}

/** Timestamps formatted with the per-event UTC options: one per rendered event row. */
function eventTimestampReads(): number {
  return formatDateOptions.mock.calls.filter(([options]) => hasEventTimestampOptions(options))
    .length;
}

beforeEach(() => {
  useQuery.mockReset();
  formatDateOptions.mockClear();
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

describe('AuditReportScreen collapsed finding sections', () => {
  it('leaves the events of a collapsed finding unread', () => {
    const root = renderScreen();

    // Only the header's generatedAt reads a timestamp; the five event rows are
    // not built while the section is collapsed.
    expect(eventTimestampReads()).toBe(1);
    expect(textStrings(root.root)).not.toContain('Reason: Vulnerable code is not used');
  });

  it('reads every event once the section is expanded', () => {
    const root = renderScreen();
    expect(eventTimestampReads()).toBe(1);

    press(root.root, FINDING.title);

    expect(eventTimestampReads()).toBe(1 + FINDING.events.length);
    expect(textStrings(root.root)).toContain('Reason: Vulnerable code is not used');
    expect(textStrings(root.root)).toContain('Confidence: High');
  });
});
