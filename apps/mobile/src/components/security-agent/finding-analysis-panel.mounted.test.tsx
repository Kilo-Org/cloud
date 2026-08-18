/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Finding-analysis completion-copy gate: sandbox/triage evidence is
// authoritative only once the analysis reached a terminal sandbox/triage
// state. A stale result left behind by a failed retry must not read as
// "Analyzed" in queued/running/failed — the panel hides the sandbox
// ("Exploitable") and triage ("Triage confidence") evidence blocks in those
// states even when `analysis.analysis` still carries old data.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingAnalysisPanel } from './finding-analysis-panel';
import { type SecurityAnalysis } from '@/lib/security-agent';

const capacity = vi.hoisted(() => ({
  runningCount: 0,
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
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: () => null }));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: () => null,
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: () => null,
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: () => null }));
vi.mock('@/components/query-error', () => ({ QueryError: () => null }));
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

function staleAnalysis(): Record<string, unknown> {
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

function renderPanel(analysis: SecurityAnalysis): R {
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
