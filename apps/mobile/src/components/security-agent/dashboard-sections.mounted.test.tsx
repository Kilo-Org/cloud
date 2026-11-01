// The dashboard sections read the same sync state the filter row paints under
// "All repositories". Before the first sync nothing has been measured, so the
// priority card must not report the empty result as a clean codebase: the
// green check and the all-clear line gave a never-synced organization a
// verified look. The card explains what it will hold instead, and opens
// nothing.

import { type ComponentProps } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { DashboardSections } from './dashboard-sections';

// The counted bucket helper is spied on: a line that names three counts can
// only agree them if each bucket is handed to its own plural family with its
// own count, so what the row passes here is the thing worth pinning.
const { severityCountPhrase } = vi.hoisted(() => ({
  severityCountPhrase: vi.fn((bucket: string, count: number) => `${bucket}:${count}`),
}));
vi.mock('@/components/security-agent/severity-count-phrase', () => ({ severityCountPhrase }));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Text: 'Text',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({
  i18n: { language: 'en', t: (key: string) => key },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/icons', () => ({
  Clock: 'Clock',
  FolderGit2: 'FolderGit2',
  ShieldCheck: 'ShieldCheck',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalArrowRight: 'DirectionalArrowRight',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ good: '#0a0', mutedForeground: '#666', muted: '#999' }),
}));
vi.mock('@/lib/hooks/use-single-push-route', () => ({
  useSinglePushRoute: () => vi.fn(),
}));
vi.mock('@/lib/security-agent', () => ({
  getSecurityAgentPath: (scope: string, section: string) => `/security/${scope}/${section}`,
}));
vi.mock('@/lib/format', () => ({
  formatNumber: String,
  formatPercent: (value: number) => `${value}%`,
  UNMEASURED_VALUE: '—',
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));

type DashboardData = ComponentProps<typeof DashboardSections>['data'];

function dashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  const data: DashboardData = {
    analysis: {
      total: 0,
      analyzed: 0,
      exploitable: 0,
      notExploitable: 0,
      triageComplete: 0,
      safeToDismiss: 0,
      needsReview: 0,
      analyzing: 0,
      notAnalyzed: 0,
      failed: 0,
    },
    severity: { critical: 0, high: 0, medium: 0, low: 0 },
    status: { open: 0, fixed: 0, ignored: 0 },
    sla: {
      overall: { total: 0, withinSla: 0, overdue: 0 },
      bySeverity: {
        critical: { total: 0, withinSla: 0, overdue: 0 },
        high: { total: 0, withinSla: 0, overdue: 0 },
        medium: { total: 0, withinSla: 0, overdue: 0 },
        low: { total: 0, withinSla: 0, overdue: 0 },
      },
      dueSoon: { total: 0, exploitable: 0 },
      untrackedCount: 0,
    },
    mttr: {
      bySeverity: {
        critical: { avgDays: null, medianDays: null, count: 0, slaDays: 15 },
        high: { avgDays: null, medianDays: null, count: 0, slaDays: 30 },
        medium: { avgDays: null, medianDays: null, count: 0, slaDays: 45 },
        low: { avgDays: null, medianDays: null, count: 0, slaDays: 90 },
      },
    },
    overdue: [],
    priorityFinding: null,
    repoHealth: [],
    repositoryCount: 0,
  };
  return Object.assign(data, overrides);
}

type Instance = TestRenderer.ReactTestInstance;

function renderSections(props: {
  data?: DashboardData;
  slaEnabled?: boolean;
  neverSynced?: boolean;
}): TestRenderer.ReactTestRenderer {
  // The renderer only exists inside the act pass, so the slot starts empty.
  const slot: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    slot.current = TestRenderer.create(
      <DashboardSections
        scope="personal"
        data={props.data ?? dashboardData()}
        slaEnabled={props.slaEnabled ?? true}
        repoFullName={undefined}
        neverSynced={props.neverSynced ?? false}
      />
    );
  });
  const renderer = slot.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function copy(instance: Instance): unknown[] {
  return instance.findAllByType('Text').map(node => node.props.children);
}

/** The card that holds the priority section, found by its title line. */
function priorityCard(renderer: TestRenderer.ReactTestRenderer): Instance {
  const card = renderer.root
    .findAllByType('View')
    .find(node => copy(node).includes('securityAgent.dashboard.actFirst'));
  if (!card) {
    throw new Error('priority card not found');
  }
  return card;
}

/** The Codebase risk card, found by its title line. */
function coverageCard(renderer: TestRenderer.ReactTestRenderer): Instance {
  const card = renderer.root
    .findAllByType('View')
    .find(node => copy(node).includes('securityAgent.dashboard.codebaseRisk'));
  if (!card) {
    throw new Error('coverage card not found');
  }
  return card;
}

describe('DashboardSections priority card', () => {
  it('reports no measurement while the scope has never synced', () => {
    const card = priorityCard(renderSections({ neverSynced: true }));

    // The card is a content section, so it explains what it will hold instead
    // of showing the lone dash a measurement row shows or repeating the status
    // the filter above states. The all-clear copy and its green check belong to
    // a measured report, and nothing here opens.
    expect(copy(card)).toContain('securityAgent.dashboard.actFirst');
    expect(copy(card)).toContain('securityAgent.dashboard.priorityFindingsPending');
    expect(copy(card)).not.toContain('securityAgent.dashboard.notYetSynced');
    expect(copy(card)).not.toContain('securityAgent.dashboard.noOpenFindings');
    expect(card.findAllByType('ShieldCheck')).toHaveLength(0);
    expect(card.findAllByType('Pressable')).toHaveLength(0);
  });

  it('keeps the all-clear row for a synced organization with no open findings', () => {
    const card = priorityCard(renderSections({ neverSynced: false }));

    expect(copy(card)).toContain('securityAgent.dashboard.noOpenFindings');
    expect(card.findAllByType('ShieldCheck')).toHaveLength(1);
    // Nothing is waiting, so the row is a statement: a press state would
    // promise a findings list that has nothing in it.
    expect(card.findAllByType('Pressable')).toHaveLength(0);
  });
});

describe('DashboardSections stat rows', () => {
  // The counts below the priority card are read from the same sync the filter
  // dates; before the first one they were zeros, and two of them carried a
  // success dot. A dash and a neutral dot state that nothing was measured.
  it('reports every stat row as unmeasured while the scope has never synced', () => {
    const rows = renderSections({ neverSynced: true }).root.findAllByType('KvRow');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.props.value === '—')).toBe(true);
    expect(
      rows.every(row => row.props.dotTone === 'muted' || row.props.dotTone === undefined)
    ).toBe(true);
  });

  it('keeps the measured counts for a synced organization', () => {
    const rows = renderSections({ neverSynced: false }).root.findAllByType('KvRow');

    // The SLA figures live on the metric tiles above these rows, so every row
    // here is a measured coverage count: a number, never the unmeasured dash.
    expect(rows.map(row => row.props.value)).not.toContain('—');
    expect(rows.map(row => row.props.value)).toContain('0');
    // Synced, so the counts are real numbers rather than dashes — and with
    // nothing counted in any of them the dots stay neutral, because a zero is
    // a satisfied row rather than a severity.
    expect(
      rows.every(row => row.props.dotTone === 'muted' || row.props.dotTone === undefined)
    ).toBe(true);
  });
});

describe('DashboardSections repository row', () => {
  // One line names three counts, so a single `count` on the line cannot agree
  // any of them: each bucket has to reach its own plural family with its own
  // count. A formatted number passed instead would render the plural form for
  // every count — "1 críticas" — which is the defect this pins.
  it('names each bucket through its own counted phrase', () => {
    severityCountPhrase.mockClear();
    renderSections({
      neverSynced: false,
      data: dashboardData({
        repoHealth: [
          {
            repoFullName: 'drain-e2e-labs/notes',
            open: 3,
            critical: 1,
            high: 1,
            medium: 1,
            low: 0,
            overdue: 2,
            exploitable: 1,
            needsAction: 3,
            slaCompliancePercent: 33.3,
            slaComplianceMeasured: true,
          },
        ],
      }),
    });

    expect(severityCountPhrase.mock.calls).toEqual([
      ['repoOpen', 3],
      ['repoCritical', 1],
      ['repoHigh', 1],
    ]);
  });
});

describe('DashboardSections SLA posture', () => {
  // The compliance and deadline tiles above these sections already state the
  // within-deadline ratio and the per-severity overdue counts. The posture card
  // repeated them, so it is gone while SLA tracking is on; the analysis posture
  // it still shows is the part the tiles leave out.
  it('leaves the SLA figures to the tiles while SLA tracking is on', () => {
    const labels = renderSections({ neverSynced: false, slaEnabled: true })
      .root.findAllByType('KvRow')
      .map(row => row.props.label);

    expect(labels).not.toContain('securityAgent.dashboard.withinDeadline');
    expect(labels).not.toContain('securityAgent.dashboard.criticalOverdue');
    expect(labels).not.toContain('securityAgent.dashboard.highOverdue');
    expect(labels).not.toContain('securityAgent.dashboard.mediumLowOverdue');
  });

  it('keeps the analysis posture for a scope without SLA tracking', () => {
    const labels = renderSections({ neverSynced: false, slaEnabled: false })
      .root.findAllByType('KvRow')
      .map(row => row.props.label);

    expect(labels).toContain('securityAgent.dashboard.confirmedExploitable');
    expect(labels).toContain('securityAgent.dashboard.noImmediateAction');
  });
});

describe('DashboardSections Codebase risk card', () => {
  // The untracked count is already the "No deadline" tile above these cards, so
  // the risk card carried the same number a second time under its own label.
  // The rows here are the analysis outcomes, and they do not depend on SLA
  // tracking: the card reads the same with it on and off.
  it('keeps the same outcome rows with and without SLA tracking', () => {
    const labels = (slaEnabled: boolean) =>
      coverageCard(
        renderSections({
          neverSynced: false,
          slaEnabled,
          data: dashboardData({
            sla: {
              ...dashboardData().sla,
              untrackedCount: 5,
            },
          }),
        })
      )
        .findAllByType('KvRow')
        .map(row => row.props.label);

    expect(labels(true)).toHaveLength(4);
    expect(labels(true)).toEqual(labels(false));
  });
});
