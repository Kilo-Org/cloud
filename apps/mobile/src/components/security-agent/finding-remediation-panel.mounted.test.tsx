/* eslint-disable max-lines -- the mounted remediation timeline shares one native test fixture. */

// Finding-remediation progress timeline: the panel renders the ordered
// remediation audit events (queued → pr_opened, or a terminal event) above the
// attempt history. A separately released client can talk to an old backend
// that omits `remediationTimeline`, so the panel treats a missing field as an
// empty list.

import { type ComponentProps, createElement } from 'react';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AnalysisRerunAction } from '@/components/security-agent/analysis-rerun-action';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingRemediationPanel } from './finding-remediation-panel';
import { type SecurityAnalysis } from '@/lib/security-agent';

const texts = vi.hoisted(() => ({ items: [] as string[] }));
const kvRows = vi.hoisted(() => ({
  rows: [] as { label: string; value: unknown; valueLtr: boolean | undefined }[],
}));
const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  openExternalUrl: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));
vi.mock('@/lib/external-link', () => ({
  openExternalUrl: mocks.openExternalUrl,
}));
vi.mock('@/components/ui/icons', () => ({
  Wrench: 'Wrench',
}));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: (props: { children?: unknown }) => props.children ?? null,
}));
vi.mock('@/components/security-agent/analysis-rerun-action', () => ({
  AnalysisRerunAction: 'AnalysisRerunAction',
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: () => null,
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/kv-row', () => ({
  KvRow: (props: { label: string; value: unknown; valueLtr?: boolean }) => {
    kvRows.rows.push({ label: props.label, value: props.value, valueLtr: props.valueLtr });
    return null;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: unknown }) => {
    if (typeof props.children === 'string') {
      texts.items.push(props.children);
    }
    return null;
  },
}));
vi.mock('@/lib/hooks/use-security-remediation', () => ({
  useStartSecurityRemediation: () => ({ mutate: mocks.start, isPending: false }),
  useRetrySecurityRemediation: () => ({ mutate: mocks.retry, isPending: false }),
  useCancelSecurityRemediation: () => ({ mutate: mocks.cancel, isPending: false }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#fff',
    foreground: '#000',
    mutedForeground: '#666',
  }),
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getRemediationStatusPresentation: () => ({
    label: 'Not started',
    tone: 'neutral',
    icon: 'clock',
    spinning: false,
  }),
  getRemediationUnavailableCopy: () => null,
}));

type R = TestRenderer.ReactTestRenderer;

function analysisFixture(overrides: Record<string, unknown> = {}): SecurityAnalysis {
  return {
    remediationSummary: null,
    remediationCapability: {
      canStart: false,
      startReason: 'finding_not_open',
      canRetry: false,
      retryReason: 'finding_not_open',
      canCancel: false,
      cancelAttemptId: null,
    },
    remediationAttempts: [],
    remediationTimeline: [],
    ...overrides,
  } as unknown as SecurityAnalysis;
}

function renderPanel(
  analysis: SecurityAnalysis | undefined,
  props: Partial<ComponentProps<typeof FindingRemediationPanel>> = {}
): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingRemediationPanel, {
        scope: 'personal',
        findingId: 'finding-1',
        analysis,
        isLoading: false,
        isError: false,
        onRetry: () => undefined,
        ...props,
      })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function pressButtons(r: R): void {
  act(() => {
    for (const node of r.root.findAll(
      n => typeof n.type === 'string' && (n.type as string) === 'Button'
    )) {
      const onPress = node.props.onPress as (() => void) | undefined;
      onPress?.();
    }
  });
}

describe('FindingRemediationPanel remediation timeline', () => {
  beforeEach(() => {
    texts.items = [];
  });

  it('centers an empty remediation with its blocker reason', () => {
    const tree = renderPanel(analysisFixture());
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(1);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
    expect(texts.items).toContain('Finding is no longer open.');
    expect(tree.root.findAllByType(Button)).toHaveLength(0);
  });

  it.each([
    { remediationSummary: { status: 'queued' } },
    {
      remediationAttempts: [
        {
          id: 'attempt-1',
          status: 'running',
          origin: 'manual',
          updatedAt: '2026-04-29T02:00:00.000Z',
        },
      ],
    },
    {
      remediationTimeline: [
        { action: 'security.remediation.queued', occurredAt: '2026-04-29T01:16:12.945Z' },
      ],
    },
  ])('keeps substantive remediation content in the report scroller: %j', content => {
    const tree = renderPanel(analysisFixture(content), { isError: true });
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
  });

  it('centers the absent response without another container', () => {
    const tree = renderPanel(undefined);
    expect(tree.root.findByType(EmptyState).props.placement).not.toBe('top');
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
  });

  it('keeps loading ahead of an absent response failure', () => {
    const tree = renderPanel(undefined, { isLoading: true, isError: true });
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(2);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
  });

  it('keeps Retry in a full-body absent response failure', () => {
    const onRetry = vi.fn<() => void>();
    const tree = renderPanel(undefined, { isError: true, onRetry });
    const error = tree.root.findByType(QueryError);
    expect(error.props.placement).not.toBe('top');
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
    act(error.props.onRetry as () => void);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('preserves server-approved actions in the centered state', () => {
    const tree = renderPanel(
      analysisFixture({
        remediationCapability: { canStart: true, canRetry: true, canCancel: false },
      })
    );
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(1);
    pressButtons(tree);
    expect(mocks.start).toHaveBeenCalledWith({ findingId: 'finding-1' });
    expect(mocks.retry).toHaveBeenCalledWith({ findingId: 'finding-1' });
  });

  it('renders remediation timeline labels in order', () => {
    renderPanel(
      analysisFixture({
        remediationTimeline: [
          { action: 'security.remediation.queued', occurredAt: '2026-04-29T01:16:12.945Z' },
          { action: 'security.remediation.pr_opened', occurredAt: '2026-04-29T02:00:00.000Z' },
        ],
      })
    );

    const queuedIndex = texts.items.indexOf('Remediation requested');
    const prOpenedIndex = texts.items.indexOf('PR opened');
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    expect(prOpenedIndex).toBeGreaterThan(queuedIndex);
  });

  it('renders terminal labels for failed, blocked, no_changes_needed, and cancelled', () => {
    renderPanel(
      analysisFixture({
        remediationTimeline: [
          { action: 'security.remediation.failed', occurredAt: '2026-04-29T01:00:00.000Z' },
          { action: 'security.remediation.blocked', occurredAt: '2026-04-29T01:01:00.000Z' },
          {
            action: 'security.remediation.no_changes_needed',
            occurredAt: '2026-04-29T01:02:00.000Z',
          },
          { action: 'security.remediation.cancelled', occurredAt: '2026-04-29T01:03:00.000Z' },
        ],
      })
    );

    expect(texts.items).toContain('Remediation failed');
    expect(texts.items).toContain('Remediation blocked');
    expect(texts.items).toContain('No changes needed');
    expect(texts.items).toContain('Cancelled');
  });

  it.each([[], undefined])('renders an empty or omitted timeline: %j', remediationTimeline => {
    const r = renderPanel(analysisFixture({ remediationTimeline }));

    expect(r.toJSON()).not.toBeNull();
    expect(texts.items).not.toContain('Progress');
    expect(texts.items).not.toContain('Remediation requested');
  });
});

describe('FindingRemediationPanel pull request navigation', () => {
  beforeEach(() => {
    texts.items = [];
    mocks.routerPush.mockReset();
    mocks.openExternalUrl.mockReset();
  });

  it.each([
    ['https://github.com/kilo/kilo/pull/123', '/(app)/pr-review/kilo/kilo/123'],
    [
      'https://gitlab.com/kilo/kilo/-/merge_requests/123',
      '/(app)/pr-review/gitlab/kilo/kilo/123?instance=https%3A%2F%2Fgitlab.com',
    ],
    [
      'https://bitbucket.org/kilo/kilo/pull-requests/123',
      '/(app)/pr-review/bitbucket/kilo/kilo/123',
    ],
    ['https://github.example.com/kilo/kilo/pull/123', null],
  ] as const)('opens %s at its supported destination', (prUrl, expectedHref) => {
    pressButtons(
      renderPanel(analysisFixture({ remediationSummary: { status: 'pr_opened', prUrl } }))
    );
    if (expectedHref) {
      expect(mocks.routerPush).toHaveBeenCalledWith(expectedHref);
      expect(mocks.openExternalUrl).not.toHaveBeenCalled();
    } else {
      expect(mocks.routerPush).not.toHaveBeenCalled();
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(prUrl, { label: 'pull request' });
    }
  });

  it('routes both the summary and attempt buttons in-app', () => {
    const r = renderPanel(
      analysisFixture({
        remediationSummary: {
          status: 'pr_opened',
          prUrl: 'https://github.com/kilo/kilo/pull/123',
          prNumber: 123,
          prDraft: false,
          outcomeSummary: null,
        },
        remediationAttempts: [
          {
            id: 'attempt-1',
            attemptNumber: 1,
            status: 'pr_opened',
            prUrl: 'https://github.com/kilo/kilo/pull/456',
            prNumber: 456,
            prDraft: false,
            origin: 'manual',
            remediationModelSlug: 'gpt-5',
            branchName: 'fix/thing',
            updatedAt: '2026-04-29T02:00:00.000Z',
            cancellationRequestedAt: null,
            validationEvidence: [],
            riskNotes: null,
            draftReason: null,
            blockedReason: null,
            lastErrorRedacted: null,
          },
        ],
      })
    );

    pressButtons(r);

    expect(mocks.routerPush).toHaveBeenCalledTimes(2);
    expect(mocks.routerPush).toHaveBeenNthCalledWith(1, '/(app)/pr-review/kilo/kilo/123');
    expect(mocks.routerPush).toHaveBeenNthCalledWith(2, '/(app)/pr-review/kilo/kilo/456');
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });
});

describe('FindingRemediationPanel stale analysis action', () => {
  const staleCapability = {
    canStart: false,
    startReason: 'stale_analysis',
    canRetry: false,
    retryReason: 'stale_analysis',
    canCancel: false,
    cancelAttemptId: null,
  };

  beforeEach(() => {
    texts.items = [];
  });

  it('offers the rerun action the blocker copy asks for', () => {
    const tree = renderPanel(analysisFixture({ remediationCapability: staleCapability }));

    expect(texts.items).toContain(
      'Finding changed after analysis. Rerun analysis before starting remediation.'
    );
    expect(tree.root.findAllByType(AnalysisRerunAction)).toHaveLength(1);
  });

  it.each([
    {
      remediationAttempts: [
        { id: 'attempt-1', status: 'failed', origin: 'manual', updatedAt: '2026-04-29T02:00:00Z' },
      ],
    },
    { remediationSummary: { status: 'failed', latestAttemptId: 'attempt-1' } },
  ])('keeps the action off a finding that already ran remediation: %j', content => {
    const tree = renderPanel(
      analysisFixture({ remediationCapability: staleCapability, ...content })
    );

    expect(tree.root.findAllByType(AnalysisRerunAction)).toHaveLength(0);
  });

  it.each([
    { startReason: 'not_exploitable', retryReason: 'not_exploitable' },
    { startReason: 'analysis_required', retryReason: 'analysis_required' },
  ])('leaves the action to the blocker that names it: %j', reasons => {
    const tree = renderPanel(
      analysisFixture({
        remediationCapability: { ...staleCapability, ...reasons },
      })
    );

    expect(tree.root.findAllByType(AnalysisRerunAction)).toHaveLength(0);
  });

  it('offers it on the retry reason when only the retry is stale', () => {
    const tree = renderPanel(
      analysisFixture({
        remediationCapability: {
          ...staleCapability,
          startReason: 'not_exploitable',
          retryReason: 'stale_analysis',
        },
      })
    );

    expect(tree.root.findAllByType(AnalysisRerunAction)).toHaveLength(1);
  });
});

describe('FindingRemediationPanel stored payload tolerance', () => {
  const attempt = {
    id: 'attempt-1',
    status: 'failed',
    attemptNumber: 1,
    remediationModelSlug: 'kilo-auto/balanced',
    branchName: 'security-remediation/fix-1',
    updatedAt: '2026-04-29T02:00:00.000Z',
  };

  beforeEach(() => {
    texts.items = [];
    kvRows.rows = [];
  });

  // The attempt row reads the origin off a stored record, so a record written
  // before the field existed reaches the panel without it.
  it.each([{ origin: undefined }, { origin: null }, { origin: 7 }])(
    'labels an unusable attempt origin (%j) as unknown',
    origin => {
      const tree = renderPanel(
        analysisFixture({ remediationAttempts: [{ ...attempt, ...origin }] })
      );

      expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
      expect(kvRows.rows.find(row => row.label === 'Started by')?.value).toBe('Unknown');
    }
  );

  // The branch and model are identifiers: the row names their base direction
  // so an RTL interface does not reorder them, while the translated origin
  // beside them keeps the interface direction.
  it('isolates the model slug and branch name left-to-right', () => {
    renderPanel(analysisFixture({ remediationAttempts: [attempt] }));

    expect(kvRows.rows.find(row => row.label === 'Model')?.valueLtr).toBe(true);
    expect(kvRows.rows.find(row => row.label === 'Branch')?.valueLtr).toBe(true);
    expect(kvRows.rows.find(row => row.label === 'Started by')?.valueLtr).toBeUndefined();
  });
});
