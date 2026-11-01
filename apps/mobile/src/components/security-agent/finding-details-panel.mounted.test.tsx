/* eslint-disable max-lines -- one mounted harness covers the panel's advisory routing, chip row, dismissal copy, dates block and identifier rows */
// The details panel's advisory control uses the same link route as the other
// finding surfaces: a supported review link navigates in-app, everything else
// goes through the shared external-link helper.

import { createElement } from 'react';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { Text } from '@/components/ui/text';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingDetailsPanel } from './finding-details-panel';
import { type SecurityFinding } from '@/lib/security-agent';

const mocks = vi.hoisted(() => {
  const deadlineState: Record<string, unknown> = { kind: 'no-deadline' };
  const kvRows: Record<string, unknown>[] = [];
  return {
    deadlineState,
    deadlineTone: 'neutral' as string,
    kvRows,
    supersedingFindingId: null as string | null,
    routerPush: vi.fn(),
    openBrowser: vi.fn(),
    linkingOpenUrl: vi.fn(),
    toastError: vi.fn(),
  };
});

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Linking: { openURL: mocks.linkingOpenUrl },
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: mocks.openBrowser }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
  useFocusEffect: () => undefined,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/ui/icons', () => ({
  ExternalLink: 'ExternalLink',
  GitMerge: 'GitMerge',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/security-agent/finding-tone', () => ({
  FINDING_TONE_TEXT_CLASS: { success: '', warning: '', danger: '', neutral: '' },
  FINDING_TONE_TO_KV_ROW_TONE: {
    success: 'good',
    warning: 'warn',
    danger: 'danger',
    neutral: 'muted',
  },
  findingToneColor: () => '#666',
}));
vi.mock('@/components/ui/kv-row', () => ({
  KvRow: (props: Record<string, unknown>) => {
    mocks.kvRows.push(props);
    return null;
  },
}));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: (props: { children?: unknown }) => props.children ?? null,
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: 'FindingStatusBadge',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));
vi.mock('@/lib/format', () => ({
  formatDate: (date: Date) => date.toISOString(),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.join(' '),
  firstNonEmpty: (value: string | null, fallback: string) => value ?? fallback,
  parseTimestamp: (value: string | null) => new Date(value ?? 0),
  timeAgo: () => 'a while ago',
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getFindingLifecycleStatusPresentation: () => ({ tone: 'neutral' }),
  getFindingSeverityPresentation: () => ({ tone: 'danger' }),
  getSecurityDeadlinePresentation: () => ({
    state: mocks.deadlineState,
    tone: mocks.deadlineTone,
    icon: 'clock',
  }),
  getSupersedingFindingId: () => mocks.supersedingFindingId,
}));

type R = TestRenderer.ReactTestRenderer;

function findingFixture(overrides: Record<string, unknown> = {}): SecurityFinding {
  return {
    id: 'finding-1',
    status: 'open',
    severity: 'high',
    title: 'Prototype pollution in left-pad',
    description: null,
    package_name: 'left-pad',
    package_ecosystem: 'npm',
    vulnerable_version_range: '< 1.3.0',
    patched_version: '1.3.0',
    cve_id: 'CVE-2026-0001',
    ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
    repo_full_name: 'kilo/kilo',
    manifest_path: 'package.json',
    first_detected_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    fixed_at: null,
    sla_due_at: null,
    source: 'dependabot',
    source_id: 'source-1',
    ignored_reason: null,
    dependabot_html_url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
    ...overrides,
  } as unknown as SecurityFinding;
}

function renderPanel(finding: SecurityFinding): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingDetailsPanel, { finding, scope: 'personal' })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

/** Every string the panel painted, in tree order. */
function panelTexts(r: R): unknown[] {
  return r.root.findAllByType(Text).map(node => node.props.children);
}

function pressAdvisory(r: R): void {
  const control = r.root.find(
    n => typeof n.type === 'string' && n.props.accessibilityRole === 'link'
  );
  act(() => {
    (control.props.onPress as () => void)();
  });
}

describe('FindingDetailsPanel advisory link routing', () => {
  beforeEach(() => {
    mocks.routerPush.mockReset();
    mocks.openBrowser.mockReset();
    mocks.linkingOpenUrl.mockReset();
    mocks.toastError.mockReset();
  });

  it('opens an advisory page in the browser', async () => {
    pressAdvisory(renderPanel(findingFixture()));

    await vi.waitFor(() => {
      expect(mocks.openBrowser).toHaveBeenCalledWith(
        'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz'
      );
    });
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.linkingOpenUrl).not.toHaveBeenCalled();
  });

  it('opens a supported review link on the in-app review route', () => {
    pressAdvisory(
      renderPanel(findingFixture({ dependabot_html_url: 'https://github.com/kilo/kilo/pull/123' }))
    );

    expect(mocks.routerPush).toHaveBeenCalledWith('/(app)/pr-review/kilo/kilo/123');
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.linkingOpenUrl).not.toHaveBeenCalled();
  });

  it('keeps an unsupported destination out of the OS opener', async () => {
    pressAdvisory(
      renderPanel(findingFixture({ dependabot_html_url: 'ftp://example.com/advisories/GHSA-1' }))
    );

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('common.couldNotOpen');
    });
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.linkingOpenUrl).not.toHaveBeenCalled();
  });
});

describe('FindingDetailsPanel chip row', () => {
  it.each([
    {
      state: { kind: 'closed', superseded: false, at: new Date(0) },
      fixture: { status: 'ignored', ignored_reason: 'not_used' },
      // The dismissal card names what it holds; only the chip row lost a control.
      texts: ['securityAgent.dismiss.reason', 'securityAgent.dismiss.reasonNotUsed'],
    },
    {
      state: { kind: 'fixed', beforeDeadline: false, fixedAt: new Date(0) },
      fixture: { status: 'fixed' },
      texts: ['securityAgent.filter.fixed'],
    },
  ])(
    'drops the deadline chip that repeats the status ($fixture.status)',
    ({ state, fixture, texts }) => {
      mocks.deadlineState = state;
      const tree = renderPanel(findingFixture(fixture));

      expect(tree.root.findAllByType(FindingStatusBadge)).toHaveLength(0);
      expect(panelTexts(tree)).toEqual(expect.arrayContaining(texts));
    }
  );

  it.each([
    { state: { kind: 'fixed', beforeDeadline: true, fixedAt: new Date(0) }, status: 'fixed' },
    { state: { kind: 'due-in', days: 12, deadline: new Date(0) }, status: 'open' },
    { state: { kind: 'no-deadline' }, status: 'open' },
  ])('keeps the deadline chip a $state.kind finding carries', ({ state, status }) => {
    mocks.deadlineState = state;
    const tree = renderPanel(findingFixture({ status }));

    expect(tree.root.findAllByType(FindingStatusBadge)).toHaveLength(1);
  });
});

describe('FindingDetailsPanel stored dismissal values', () => {
  // The column's type does not guarantee `ignored_reason` is still a string.
  it.each([{ ignored_reason: 7 }, { ignored_reason: true }, { ignored_reason: '  ' }])(
    'falls back to the review wording for an unusable reason (%j)',
    override => {
      mocks.deadlineState = { kind: 'closed', superseded: false, at: new Date(0) };
      const tree = renderPanel(findingFixture({ status: 'ignored', ...override }));
      expect(panelTexts(tree)).toContain('securityAgent.findingDetails.reasonAfterReview');
    }
  );
});

describe('FindingDetailsPanel description paragraph', () => {
  // Provider markdown wraps its lines; a plain Text paints the newlines and
  // the next line's indentation as ragged fragments.
  it('collapses the wrapped source lines into one paragraph', () => {
    const description = (value: string) =>
      panelTexts(renderPanel(findingFixture({ description: value })));

    const wrapped = 'A crafted input\r\n    overflows the parser\n  and crashes.';
    expect(description(wrapped)).toContain('A crafted input overflows the parser and crashes.');
    expect(description(' \n\t ')).not.toContain('');
  });
});

describe('FindingDetailsPanel dates block', () => {
  // The labels the dates group can render; any other KvRow belongs to another
  // group on the panel.
  const DATE_LABEL_KEYS: Record<string, true> = {
    'securityAgent.findingDetails.detected': true,
    'common.updated': true,
    'securityAgent.filter.fixed': true,
    'securityAgent.findingDetails.slaDeadline': true,
    'securityAgent.findingDetails.dismissedOn': true,
    'securityAgent.findingDetails.supersededOn': true,
  };

  function dateRows() {
    return mocks.kvRows.filter(row => DATE_LABEL_KEYS[row.label as string]);
  }

  beforeEach(() => {
    mocks.kvRows.length = 0;
    mocks.deadlineState = { kind: 'no-deadline' };
    mocks.supersedingFindingId = null;
  });

  // An ignored finding has no deadline left to meet: the date it carries is
  // the day it left the open set, so it gets its own label instead of the
  // deadline label it used to sit under.
  it('labels the resolution date with the status that closed the finding', () => {
    mocks.deadlineState = { kind: 'closed', superseded: false, at: new Date(0) };
    renderPanel(
      findingFixture({
        status: 'ignored',
        sla_due_at: '2026-11-02T00:00:00.000Z',
        updated_at: '2026-10-30T00:00:00.000Z',
      })
    );

    expect(dateRows().map(row => row.label)).toEqual([
      'securityAgent.findingDetails.detected',
      'securityAgent.findingDetails.dismissedOn',
    ]);
    expect(dateRows()[1]).toMatchObject({ value: '2026-10-30T00:00:00.000Z', last: true });

    mocks.kvRows.length = 0;
    mocks.supersedingFindingId = 'finding-2';
    renderPanel(findingFixture({ status: 'ignored' }));
    expect(dateRows()[1]).toMatchObject({ label: 'securityAgent.findingDetails.supersededOn' });
  });

  it('keeps the fixed date row and drops the deadline row once the source reports the finding fixed', () => {
    mocks.deadlineState = { kind: 'fixed', beforeDeadline: true, fixedAt: new Date(0) };
    renderPanel(
      findingFixture({
        status: 'fixed',
        sla_due_at: '2026-11-02T00:00:00.000Z',
        fixed_at: '2026-10-05T00:00:00.000Z',
      })
    );

    expect(dateRows().map(row => row.label)).toEqual([
      'securityAgent.findingDetails.detected',
      'common.updated',
      'securityAgent.filter.fixed',
    ]);
  });

  // The row's own label names the deadline, so the value is the date alone: a
  // "Due 11/2/2026" under "SLA deadline" says the same thing twice.
  it('keeps the deadline row on an open finding that still has one', () => {
    mocks.deadlineState = { kind: 'due-in', days: 12, deadline: new Date(0) };
    mocks.deadlineTone = 'warning';
    renderPanel(findingFixture({ status: 'open', sla_due_at: '2026-11-02T00:00:00.000Z' }));

    expect(dateRows().map(row => row.label)).toEqual([
      'securityAgent.findingDetails.detected',
      'common.updated',
      'securityAgent.findingDetails.slaDeadline',
    ]);
    expect(dateRows()[2]).toMatchObject({
      value: '1970-01-01T00:00:00.000Z',
      valueTone: 'warn',
      last: true,
    });
  });

  it('renders no deadline row for an open finding without one', () => {
    renderPanel(findingFixture({ status: 'open', sla_due_at: null }));

    expect(dateRows().map(row => row.label)).toEqual([
      'securityAgent.findingDetails.detected',
      'common.updated',
    ]);
  });
});

describe('FindingDetailsPanel identifier values', () => {
  beforeEach(() => {
    mocks.kvRows.length = 0;
    mocks.deadlineState = { kind: 'no-deadline' };
    mocks.supersedingFindingId = null;
  });

  /** The captured row for a label; fails the test when the panel did not draw it. */
  function identifierRow(label: string): Record<string, unknown> {
    const row = mocks.kvRows.find(candidate => candidate.label === label);
    expect(row, `the panel draws the ${label} row`).toBeDefined();
    return row as Record<string, unknown>;
  }

  // A version range's `<` is neutral, so every row that carries a technical
  // token names its own base direction; the labels beside them keep the
  // interface direction. The repository is not one of them: the screen header
  // already names it, so this card does not draw a row for it.
  it('names the left-to-right direction of every identifier row', () => {
    renderPanel(findingFixture());

    for (const label of [
      'securityAgent.findingDetails.package',
      'securityAgent.findingDetails.vulnerableVersions',
      'securityAgent.findingDetails.patchedVersion',
      'securityAgent.findingDetails.cve',
      'securityAgent.findingDetails.ghsa',
      'securityAgent.findingDetails.manifest',
      'securityAgent.findingDetails.sourceId',
    ]) {
      expect(identifierRow(label).valueDirection).toBe('ltr');
    }
  });

  it('draws no row for the repository the header already names', () => {
    renderPanel(findingFixture());

    expect(mocks.kvRows.some(row => row.label === 'common.repository')).toBe(false);
  });

  // The absence of a version renders as translated copy, which keeps the
  // interface's own direction. Both rows still render, so a regression that
  // hides them when the value is absent fails here instead of passing.
  it('keeps the translated absence of a version in the interface direction', () => {
    renderPanel(findingFixture({ vulnerable_version_range: null, patched_version: null }));

    expect(
      identifierRow('securityAgent.findingDetails.vulnerableVersions').valueDirection
    ).toBeUndefined();
    expect(
      identifierRow('securityAgent.findingDetails.patchedVersion').valueDirection
    ).toBeUndefined();
  });
});
