// Panel render-crash containment: a completed analysis payload that is
// missing a field the panel's render reads (sandboxAnalysis without
// analysisAt) throws inside FindingAnalysisPanel — its isLoading/isError
// guards never see it. PanelErrorBoundary must degrade that throw to the
// local retryable error (header/tabs and the finding stay mounted in the
// real screen; here the boundary + real panel pair is under test) instead
// of letting it reach the app's root error boundary, which replaced the
// whole app with the global error screen and dropped the finding.

import { type ComponentProps } from 'react';
import { PanelErrorBoundary } from './panel-error-boundary';
import { FindingAnalysisPanel } from './finding-analysis-panel';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { act, TestRenderer } from '@/test/renderer';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SecurityAnalysis } from '@/lib/security-agent';

let events: TelemetryEvent[] = [];

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
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({
  ExternalLink: 'ExternalLink',
  ScanSearch: 'ScanSearch',
  Ban: 'Ban',
  ShieldOff: 'ShieldOff',
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
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
  CollapsibleSection: (props: { children?: unknown }) => props.children ?? null,
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: () => null,
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type R = TestRenderer.ReactTestRenderer;

// A payload whose shape the server never sends but a partial write can:
// sandboxAnalysis with a real boolean isExploitable (so the panel enters the
// terminal sandbox render branch) and `analysisAt` missing. The panel reads
// it only inside that branch, so its loading/error guards pass and the render
// itself throws (parseTimestamp(undefined) — verified against the real panel
// before this fixture was written).
function partialSandboxPayload(): Record<string, unknown> {
  const { analysisAt: _analysisAt, ...sandbox } = completeSandbox();
  return { status: 'completed', analysis: { sandboxAnalysis: sandbox } };
}

function completeSandbox(): Record<string, unknown> {
  return {
    isExploitable: true,
    extractionStatus: 'succeeded',
    summary: 'reachable path',
    exploitabilityReasoning: 'reasoning',
    suggestedAction: 'open_pr',
    suggestedFix: 'fix it',
    analysisAt: '2026-06-17T11:44:59.000Z',
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

function mountBoundary(
  analysis: SecurityAnalysis | undefined,
  props: Partial<ComponentProps<typeof PanelErrorBoundary>> = {}
): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <PanelErrorBoundary onRetry={() => undefined} {...props}>
        <FindingAnalysisPanel
          scope="personal"
          findingId="finding-1"
          analysis={analysis}
          isLoading={false}
          isError={false}
          onRetry={() => undefined}
        />
      </PanelErrorBoundary>
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

describe('PanelErrorBoundary with the real analysis panel', () => {
  beforeEach(() => {
    events = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    capacity.runningCount = 0;
    capacity.concurrencyLimit = 3;
    capacity.isLoading = false;
    capacity.isError = false;
    startAnalysis.isPending = false;
    startAnalysis.mutate.mockClear();
  });

  it('renders the local retryable error for a completed payload missing analysisAt', () => {
    const tree = mountBoundary(analysisFixture(partialSandboxPayload()));

    const error = tree.root.findByType(QueryError);
    expect(error.props.message).toBe('securityAgent.analysis.couldNotLoad');
    // The panel's own content is gone; the finding's error state is local.
    expect(tree.root.findAllByType(FindingAnalysisPanel)).toHaveLength(0);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
  });

  it('reports the panel crash through the telemetry sink with its component stack', () => {
    mountBoundary(analysisFixture(partialSandboxPayload()));

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.level).toBe('error');
    expect(event?.tags).toEqual({
      'error.subsystem': 'security-agent-finding-detail',
      'error.operation': 'render_panel',
    });
    const componentStack = event?.extra?.componentStack;
    expect(typeof componentStack).toBe('string');
    expect((componentStack as string).length).toBeGreaterThan(0);
    expect(event?.fingerprint?.slice(0, 2)).toEqual([
      'security-agent-finding-detail',
      'render_panel',
    ]);
  });

  it('keeps a healthy panel rendered without emitting telemetry', () => {
    const tree = mountBoundary(
      analysisFixture({ analysis: { sandboxAnalysis: completeSandbox() } })
    );

    expect(tree.root.findAllByType(FindingAnalysisPanel)).toHaveLength(1);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('recovers the panel when the fallback Retry refetches a whole payload', () => {
    // What the detail screen's retry does: the fallback's Retry refetches the
    // analysis query, and the parent bumps the boundary's key only once that
    // refetch settles. While the stale crashing payload is still cached, the
    // fresh boundary instance would throw again and pin the fallback through
    // the refetch.
    let query = analysisFixture(partialSandboxPayload());
    let refetchCount = 0;
    const onRetry = vi.fn<() => void>(() => {
      refetchCount += 1;
      // The screen's handler swaps the cached payload only as the refetch
      // settles; drive the query through that order here.
      query = analysisFixture({ analysis: { sandboxAnalysis: completeSandbox() } });
    });
    const tree = mountBoundary(query, { onRetry });
    expect(tree.root.findByType(QueryError)).toBeDefined();

    // First press: the fallback's own Retry button, wired to onRetry.
    const error = tree.root.findByType(QueryError);
    expect(error.props.message).toBe('securityAgent.analysis.couldNotLoad');
    expect(tree.root.findAllByType(FindingAnalysisPanel)).toHaveLength(0);
    const fallbackRetry = error.props.onRetry as () => void;
    act(() => {
      fallbackRetry();
    });

    // The refetch settled before the parent remounts the boundary: the fresh
    // instance mounts against the recovered payload and renders the panel.
    const recovered = (
      <PanelErrorBoundary key="analysis-1" onRetry={onRetry}>
        <FindingAnalysisPanel
          scope="personal"
          findingId="finding-1"
          analysis={query}
          isLoading={false}
          isError={false}
          onRetry={() => undefined}
        />
      </PanelErrorBoundary>
    );
    act(() => {
      tree.update(recovered);
    });

    expect(refetchCount).toBe(1);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByType(FindingAnalysisPanel)).toHaveLength(1);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
  });

  it('renders the Remediation tab copy through the fallbackMessage override', () => {
    const tree = mountBoundary(analysisFixture(partialSandboxPayload()), {
      fallbackMessage: 'securityAgent.remediation.couldNotLoad',
    });

    expect(tree.root.findByType(QueryError).props.message).toBe(
      'securityAgent.remediation.couldNotLoad'
    );
  });
});
