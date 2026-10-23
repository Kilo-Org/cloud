// The row's quick action is the only place the findings list offers Analyze.
// These cases pin the enablement contract: available runs, every unavailable
// capacity state keeps it disabled and names the reason for assistive tech.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { FindingRow } from './finding-row';
import { type SecurityFinding } from '@/lib/security-agent';
import { type SecurityAnalysisCapacityState } from '@/lib/security-analysis-capacity';

const startAnalysis = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Linking: { openURL: vi.fn() },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/icons', () => ({ ExternalLink: 'ExternalLink' }));
vi.mock('@/components/security-agent/finding-tone', () => ({
  FINDING_ICONS: new Proxy({}, { get: () => 'Icon' }),
  FINDING_TONE_TEXT_CLASS: { muted: 'text-muted-foreground' },
  findingToneColor: () => '#000',
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useStartSecurityAnalysis: () => startAnalysis,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getSecurityAnalysisPresentation: () => ({ icon: 'scan', tone: 'muted', spinning: false }),
  getSecurityDeadlinePresentation: () => null,
  getSecurityFindingAnalysisState: () => 'not-analyzed',
}));

type R = TestRenderer.ReactTestRenderer;

function findingFixture(overrides: Record<string, unknown> = {}): SecurityFinding {
  return {
    id: 'finding-1',
    status: 'open',
    severity: 'high',
    title: 'Unsanitized input in handler',
    repo_full_name: 'kilo/demo',
    analysis_status: null,
    analysis: null,
    remediationSummary: null,
    remediationCapability: { canStart: false, canRetry: false, canCancel: false },
    ...overrides,
  } as unknown as SecurityFinding;
}

function renderRow(
  capacityState: SecurityAnalysisCapacityState,
  finding: SecurityFinding = findingFixture()
): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingRow, { finding, scope: 'personal', slaEnabled: false, capacityState })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('FindingRow quick Analyze action', () => {
  beforeEach(() => {
    startAnalysis.isPending = false;
    startAnalysis.mutate.mockClear();
  });

  it('starts the analysis while capacity is available', () => {
    const tree = renderRow('available');
    const button = tree.root.findByType(Button);
    expect(button.props.disabled).toBe(false);
    expect(button.props.loading).toBe(false);
    expect(button.props.accessibilityHint).toBeUndefined();
    act(button.props.onPress as () => void);
    expect(startAnalysis.mutate).toHaveBeenCalledWith({
      findingId: 'finding-1',
      retrySandboxOnly: false,
    });
  });

  it.each([
    { state: 'full', hint: 'securityAgent.analysis.capacityFull' },
    { state: 'error', hint: 'securityAgent.analysis.couldNotCheckCapacity' },
    { state: 'loading', hint: undefined },
  ] as const)('keeps the action disabled and explained while $state', ({ state, hint }) => {
    const tree = renderRow(state);
    const button = tree.root.findByType(Button);
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityHint).toBe(hint);
    // Only the capacity read itself reads as busy; a full or failed read must
    // not spin forever.
    expect(button.props.loading).toBe(state === 'loading');
  });

  it('reads as busy while the start request is in flight', () => {
    startAnalysis.isPending = true;
    const tree = renderRow('available');
    expect(tree.root.findByType(Button).props.loading).toBe(true);
  });

  it('offers no Analyze action once the finding is analyzed', () => {
    const tree = renderRow('available', findingFixture({ analysis_status: 'completed' }));
    expect(tree.root.findAllByType(Button)).toHaveLength(0);
  });

  it('shows the remediation PR instead of Analyze when one is open', () => {
    const tree = renderRow(
      'available',
      findingFixture({
        remediationSummary: { status: 'pr_opened', prUrl: 'https://example.com/pr/1' },
      })
    );
    const button = tree.root.findByType(Button);
    expect(button.props.disabled).toBeUndefined();
    expect(button.props.accessibilityHint).toBeUndefined();
  });
});
