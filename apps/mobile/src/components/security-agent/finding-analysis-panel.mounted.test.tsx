/* eslint-disable max-lines -- the completion-copy gate and the stale-analysis action share one analysis fixture. */

// Finding-analysis completion-copy gate: sandbox/triage evidence is
// authoritative only once the analysis reached a terminal sandbox/triage
// state. A stale result left behind by a failed retry must not read as
// "Analyzed" in queued/running/failed — the panel hides the sandbox
// ("Exploitable") and triage ("Triage confidence") evidence blocks in those
// states even when `analysis.analysis` still carries old data.

import { type ComponentProps, createElement } from 'react';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { MarkdownText } from '@/components/agents/markdown-text';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingAnalysisPanel } from './finding-analysis-panel';
import { i18n } from '@/i18n';
import { type SecurityAnalysis } from '@/lib/security-agent';

const capacity = vi.hoisted(() => ({
  runningCount: 0 as number | undefined,
  concurrencyLimit: 3,
  isLoading: false,
  isError: false,
  state: 'available' as 'loading' | 'error' | 'available' | 'full',
  refetch: vi.fn(),
}));
const startAnalysis = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

const kvRows = vi.hoisted(() => ({
  labels: [] as string[],
  values: new Map<string, unknown>(),
  props: [] as { label: string; valueDirection: string | undefined }[],
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: () => undefined,
}));
vi.mock('@/components/ui/icons', () => ({
  ExternalLink: 'ExternalLink',
  ScanSearch: 'ScanSearch',
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAnalysisCapacity: () => capacity,
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useStartSecurityAnalysis: () => startAnalysis,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#fff',
    foreground: '#000',
    mutedForeground: '#666',
  }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: 'CollapsibleSection',
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: () => null,
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/kv-row', () => ({
  KvRow: (props: { label: string; value: unknown; valueDirection?: string }) => {
    kvRows.labels.push(props.label);
    kvRows.values.set(props.label, props.value);
    kvRows.props.push({ label: props.label, valueDirection: props.valueDirection });
    return null;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type R = TestRenderer.ReactTestRenderer;

function staleAnalysis() {
  return {
    sandboxAnalysis: {
      extractionStatus: 'succeeded',
      isExploitable: true,
      summary: 'stale summary',
      exploitabilityReasoning: 'stale reasoning',
      suggestedAction: 'fix',
      modelUsed: 'model',
      analysisAt: '2026-06-17T11:44:59.000Z',
      suggestedFix: 'fix it',
      usageLocations: ['src/a.ts'],
      rawMarkdown: 'stale report',
    },
    triage: {
      confidence: 'high',
      suggestedAction: 'dismiss',
      needsSandboxReasoning: 'stale reasoning',
    },
  };
}

function analysisFixture(overrides: Record<string, unknown> = {}): SecurityAnalysis {
  return {
    findingState: { status: 'open' },
    status: 'completed',
    startedAt: null,
    completedAt: null,
    error: null,
    analysis: null,
    sessionId: null,
    cliSessionId: null,
    remediationSummary: null,
    remediationCapability: { canStart: false, canRetry: false, canCancel: false },
    remediationAttempts: [],
    ...overrides,
  } as unknown as SecurityAnalysis;
}

function renderPanel(
  analysis: SecurityAnalysis | undefined,
  props: Partial<ComponentProps<typeof FindingAnalysisPanel>> = {}
): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingAnalysisPanel, {
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

describe('FindingAnalysisPanel completion-copy gate', () => {
  beforeEach(() => {
    kvRows.labels = [];
    kvRows.values.clear();
    capacity.runningCount = 0;
    capacity.concurrencyLimit = 3;
    capacity.isLoading = false;
    capacity.isError = false;
    capacity.state = 'available';
    startAnalysis.isPending = false;
    startAnalysis.mutate.mockClear();
  });

  it.each([null, 'completed', 'pending', 'running', 'failed'])(
    'centers a contentless %s analysis',
    status => {
      const tree = renderPanel(analysisFixture({ status }));
      expect(tree.root.findAllByType(CenteredState)).toHaveLength(1);
      expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
      expect(tree.root.findAllByType(EmptyState)).toHaveLength(0);
    }
  );

  it.each([
    { triage: staleAnalysis().triage },
    { sandboxAnalysis: { ...staleAnalysis().sandboxAnalysis, rawMarkdown: undefined } },
    { rawMarkdown: 'Retained technical report' },
  ])('keeps substantive evidence in the report scroller: %j', analysis => {
    const tree = renderPanel(analysisFixture({ analysis }), { isError: true });
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
    expect(tree.root.findAllByType(MarkdownText)).toHaveLength('rawMarkdown' in analysis ? 1 : 0);
  });

  it('keeps a Markdown report after a failed retry', () => {
    const tree = renderPanel(analysisFixture({ status: 'failed', analysis: staleAnalysis() }));
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
    expect(tree.root.findByType(MarkdownText).props.value).toBe('stale report');
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

  it.each(['loading', 'error', 'full'] as const)(
    'keeps analysis disabled when capacity is %s',
    state => {
      capacity.state = state;
      const tree = renderPanel(analysisFixture({ status: null }));
      const button = tree.root.findByType(Button);
      expect(button.props.disabled).toBe(true);
      const hints = {
        full: i18n.t('securityAgent.analysis.capacityFull'),
        error: i18n.t('securityAgent.analysis.couldNotCheckCapacity'),
        loading: undefined,
      };
      expect(button.props.accessibilityHint).toBe(hints[state]);
      expect(tree.root.findAllByType(CenteredState)).toHaveLength(1);
    }
  );

  it('keeps the analysis action in the centered state', () => {
    const tree = renderPanel(analysisFixture({ status: null }));
    const button = tree.root.findByType(Button);
    expect(button.props.disabled).toBe(false);
    act(button.props.onPress as () => void);
    expect(startAnalysis.mutate).toHaveBeenCalledWith({
      findingId: 'finding-1',
      retrySandboxOnly: false,
    });
  });

  it('explains a full capacity under the disabled action', () => {
    capacity.state = 'full';
    const tree = renderPanel(analysisFixture({ status: null }));
    const rendered = tree.root.findAllByType(Text);
    expect(
      rendered.filter(node => node.props.children === i18n.t('securityAgent.analysis.capacityFull'))
    ).toHaveLength(1);
  });

  it('keeps the capacity explanation off an already analyzed finding', () => {
    capacity.state = 'full';
    const tree = renderPanel(analysisFixture({ status: 'completed' }));
    const rendered = tree.root.findAllByType(Text);
    expect(
      rendered.filter(node => node.props.children === i18n.t('securityAgent.analysis.capacityFull'))
    ).toHaveLength(0);
  });

  it('retries a failed capacity read from the explanation', () => {
    capacity.state = 'error';
    const tree = renderPanel(analysisFixture({ status: null }));
    const [retry] = tree.root.findAll(
      node =>
        typeof node.type === 'string' && node.props.accessibilityLabel === i18n.t('common.retry')
    );
    expect(retry).toBeDefined();
    const onRetry: unknown = retry?.props.onPress;
    expect(typeof onRetry).toBe('function');
    act(onRetry as () => void);
    expect(capacity.refetch).toHaveBeenCalledOnce();
  });

  it('hides stale sandbox and triage evidence while the analysis is running', () => {
    renderPanel(analysisFixture({ status: 'running', analysis: staleAnalysis() }));

    expect(kvRows.labels).not.toContain('Exploitable');
    expect(kvRows.labels).not.toContain('Triage confidence');
  });

  it('hides stale sandbox and triage evidence while the analysis is queued', () => {
    renderPanel(analysisFixture({ status: 'pending', analysis: staleAnalysis() }));

    expect(kvRows.labels).not.toContain('Exploitable');
    expect(kvRows.labels).not.toContain('Triage confidence');
  });

  it('hides stale sandbox and triage evidence after a failed analysis', () => {
    renderPanel(analysisFixture({ status: 'failed', analysis: staleAnalysis() }));

    expect(kvRows.labels).not.toContain('Exploitable');
    expect(kvRows.labels).not.toContain('Triage confidence');
  });

  it('shows sandbox evidence once the analysis reached a terminal sandbox state', () => {
    renderPanel(
      analysisFixture({
        status: 'completed',
        analysis: { sandboxAnalysis: staleAnalysis().sandboxAnalysis },
      })
    );

    expect(kvRows.labels).toContain('Exploitable');
  });

  it('shows triage evidence once the analysis reached a terminal triage state', () => {
    renderPanel(
      analysisFixture({
        status: 'completed',
        analysis: { triage: staleAnalysis().triage },
      })
    );

    expect(kvRows.labels).toContain('Triage confidence');
  });

  // `security_findings.analysis` is jsonb with a compile-time type only, so a
  // stored analysis written before a field existed (or seeded) reaches the
  // panel without it. The panel renders the rows it has and labels the rest as
  // not recorded instead of throwing into the panel's error boundary.
  it.each<{ name: string; analysis: Record<string, unknown>; expected: [string, string][] }>([
    {
      name: 'triage without confidence or suggested action',
      analysis: { triage: { needsSandboxReasoning: 'Runtime dependency.' } },
      expected: [
        ['Triage confidence', i18n.t('securityAgent.analysis.notRecorded')],
        ['Suggested action', i18n.t('securityAgent.analysis.notRecorded')],
      ],
    },
    {
      name: 'sandbox without suggested action',
      analysis: {
        sandboxAnalysis: {
          isExploitable: 'unknown',
          exploitabilityReasoning: 'Needs review.',
          summary: 'Needs review.',
          suggestedFix: 'Upgrade it.',
          analysisAt: '2026-06-17T11:44:59.000Z',
        },
      },
      expected: [
        ['Exploitable', i18n.t('common.unknown')],
        ['Suggested action', i18n.t('securityAgent.analysis.notRecorded')],
      ],
    },
  ])('renders an analysis whose $name', ({ analysis, expected }) => {
    const tree = renderPanel(analysisFixture({ status: 'completed', analysis }));

    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
    expect(kvRows.labels).toEqual(expect.arrayContaining(expected.map(([label]) => label)));
    for (const [label, value] of expected) {
      expect(kvRows.values.get(label)).toBe(value);
    }
  });
});

describe('FindingAnalysisPanel stale analysis action', () => {
  const staleCapability = {
    canStart: false,
    startReason: 'stale_analysis',
    canRetry: false,
    retryReason: 'stale_analysis',
    canCancel: false,
    cancelAttemptId: null,
  };

  function rerunButtons(tree: R) {
    return tree.root.findAll(
      node =>
        node.type === Button &&
        node.props.children === i18n.t('securityAgent.analysis.rerunAnalysis')
    );
  }

  beforeEach(() => {
    kvRows.labels = [];
    capacity.runningCount = 0;
    capacity.concurrencyLimit = 3;
    capacity.isLoading = false;
    capacity.isError = false;
    capacity.state = 'available';
    capacity.refetch.mockClear();
    startAnalysis.isPending = false;
    startAnalysis.mutate.mockClear();
  });

  it('offers the rerun action a completed analysis cannot', () => {
    const tree = renderPanel(
      analysisFixture({
        status: 'completed',
        analysis: { sandboxAnalysis: staleAnalysis().sandboxAnalysis },
        remediationCapability: staleCapability,
      })
    );

    const [rerun] = rerunButtons(tree);
    expect(rerun).toBeDefined();
    act(rerun?.props.onPress as () => void);
    expect(startAnalysis.mutate).toHaveBeenCalledWith({ findingId: 'finding-1' });
  });

  it('keeps the action off a finding that already ran remediation', () => {
    const tree = renderPanel(
      analysisFixture({
        status: 'completed',
        remediationCapability: staleCapability,
        remediationAttempts: [
          {
            id: 'attempt-1',
            status: 'failed',
            origin: 'manual',
            updatedAt: '2026-04-29T02:00:00Z',
          },
        ],
      })
    );

    expect(rerunButtons(tree)).toHaveLength(0);
  });

  it('disables the rerun action at full capacity and explains it', () => {
    capacity.state = 'full';
    const tree = renderPanel(
      analysisFixture({
        status: 'completed',
        remediationCapability: staleCapability,
      })
    );

    const [rerun] = rerunButtons(tree);
    expect(rerun?.props.disabled).toBe(true);
    const rendered = tree.root.findAllByType(Text);
    expect(
      rendered.filter(node => node.props.children === i18n.t('securityAgent.analysis.capacityFull'))
    ).toHaveLength(1);
  });

  it('retries a failed capacity read under the rerun action', () => {
    capacity.state = 'error';
    const tree = renderPanel(
      analysisFixture({
        status: 'completed',
        remediationCapability: staleCapability,
      })
    );

    const retry = tree.root.findAll(
      node =>
        typeof node.type === 'string' && node.props.accessibilityLabel === i18n.t('common.retry')
    )[0];
    act(retry?.props.onPress as () => void);
    expect(capacity.refetch).toHaveBeenCalledOnce();
  });
});

describe('FindingAnalysisPanel identifier values', () => {
  beforeEach(() => {
    kvRows.labels = [];
    kvRows.props = [];
  });

  /** The captured Model row; fails the test when the panel did not draw it. */
  function modelRow(): { label: string; valueDirection: string | undefined } {
    const row = kvRows.props.find(candidate => candidate.label === i18n.t('common.model'));
    expect(row, 'the panel draws the Model row').toBeDefined();
    return row as { label: string; valueDirection: string | undefined };
  }

  it('isolates the analysed model left-to-right', () => {
    renderPanel(analysisFixture({ status: 'completed', analysis: staleAnalysis() }));

    expect(modelRow().valueDirection).toBe('ltr');
  });

  // The stored analysis can name the model without the sandbox result that
  // usually carries it; that value is still an identifier.
  it('isolates a model named only by the analysis record', () => {
    renderPanel(
      analysisFixture({
        status: 'completed',
        analysis: {
          sandboxAnalysis: { ...staleAnalysis().sandboxAnalysis, modelUsed: undefined },
          analysisModel: 'kilo-auto/balanced',
        },
      })
    );

    expect(modelRow()).toMatchObject({ valueDirection: 'ltr' });
    expect(kvRows.values.get(i18n.t('common.model'))).toBe('kilo-auto/balanced');
  });

  it('keeps the unrecorded model copy in the interface direction', () => {
    renderPanel(
      analysisFixture({
        status: 'completed',
        analysis: {
          sandboxAnalysis: { ...staleAnalysis().sandboxAnalysis, modelUsed: undefined },
        },
      })
    );

    expect(modelRow().valueDirection).toBeUndefined();
    expect(kvRows.values.get(i18n.t('common.model'))).toBe(
      i18n.t('securityAgent.analysis.notRecorded')
    );
  });

  // A path's leading separator is neutral, so an RTL paragraph would move it
  // to the end of the run and draw the rest of the path back to front.
  it('isolates a located path left-to-right', () => {
    const tree = renderPanel(analysisFixture({ status: 'completed', analysis: staleAnalysis() }));

    const [location] = tree.root.findAll(
      node => Object.is(node.type, 'Text') && node.props.children === 'src/a.ts'
    );
    expect(location, 'the panel draws the located path').toBeDefined();
    expect(location?.props.style).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
  });
});
