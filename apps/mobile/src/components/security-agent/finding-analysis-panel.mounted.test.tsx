/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

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
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingAnalysisPanel } from './finding-analysis-panel';
import { type SecurityAnalysis } from '@/lib/security-agent';

const capacity = vi.hoisted(() => ({
  runningCount: 0 as number | undefined,
  concurrencyLimit: 3,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const startAnalysis = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

const kvRows = vi.hoisted(() => ({
  labels: [] as string[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
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
  KvRow: (props: { label: string }) => {
    kvRows.labels.push(props.label);
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
    capacity.runningCount = 0;
    capacity.concurrencyLimit = 3;
    capacity.isLoading = false;
    capacity.isError = false;
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
      capacity.isLoading = state === 'loading';
      capacity.isError = state === 'error';
      capacity.runningCount = state === 'full' ? 3 : undefined;
      const tree = renderPanel(analysisFixture({ status: null }));
      expect(tree.root.findByType(Button).props.disabled).toBe(true);
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
});
