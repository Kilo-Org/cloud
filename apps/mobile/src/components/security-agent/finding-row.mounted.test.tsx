// The finding row's quick action follows the same link route as the
// remediation panel: a supported review link navigates in-app, everything
// else goes through the shared external-link helper.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingRow } from './finding-row';
import { type SecurityFinding } from '@/lib/security-agent';

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  startAnalysis: vi.fn(),
  openBrowser: vi.fn(),
  linkingOpenUrl: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Linking: { openURL: mocks.linkingOpenUrl },
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: mocks.openBrowser }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  Brain: 'Brain',
  CheckCircle2: 'CheckCircle2',
  Clock3: 'Clock3',
  ExternalLink: 'ExternalLink',
  Eye: 'Eye',
  Loader2: 'Loader2',
  Shield: 'Shield',
  ShieldAlert: 'ShieldAlert',
  ShieldCheck: 'ShieldCheck',
  XCircle: 'XCircle',
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useStartSecurityAnalysis: () => ({ mutate: mocks.startAnalysis, isPending: false }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    good: '#090',
    warn: '#a60',
    destructive: '#c00',
  }),
}));
vi.mock('@/lib/security-agent-copy', () => ({
  getSecurityAnalysisLabel: () => 'Not analyzed',
  getDeadlineCopy: () => ({ label: '', detail: '' }),
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getSecurityAnalysisPresentation: () => ({ icon: 'shield', tone: 'neutral', spinning: false }),
  getSecurityDeadlinePresentation: () => null,
  getSecurityFindingAnalysisState: () => 'not-analyzed',
}));

type R = TestRenderer.ReactTestRenderer;

const PR_OPENED = { status: 'pr_opened' } as const;

function findingFixture(overrides: Record<string, unknown> = {}): SecurityFinding {
  return {
    id: 'finding-1',
    status: 'open',
    severity: 'high',
    title: 'Prototype pollution in left-pad',
    repo_full_name: 'kilo/kilo',
    analysis_status: null,
    analysis: null,
    sla_due_at: null,
    remediationSummary: { ...PR_OPENED, prUrl: 'https://github.com/kilo/kilo/pull/123' },
    ...overrides,
  } as unknown as SecurityFinding;
}

function renderRow(finding: SecurityFinding): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingRow, {
        finding,
        scope: 'personal',
        slaEnabled: false,
        hasAnalysisCapacity: true,
      })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function pressQuickAction(r: R): void {
  const buttons = r.root.findAll(
    n => typeof n.type === 'string' && (n.type as string) === 'Button'
  );
  const button = buttons[0];
  if (!button) {
    throw new Error('no quick action rendered');
  }
  act(() => {
    (button.props.onPress as () => void)();
  });
}

describe('FindingRow quick action link routing', () => {
  beforeEach(() => {
    mocks.routerPush.mockReset();
    mocks.openBrowser.mockReset();
    mocks.linkingOpenUrl.mockReset();
    mocks.toastError.mockReset();
  });

  it('opens a supported review link on the in-app review route', () => {
    pressQuickAction(renderRow(findingFixture()));

    expect(mocks.routerPush).toHaveBeenCalledWith('/(app)/pr-review/kilo/kilo/123');
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.linkingOpenUrl).not.toHaveBeenCalled();
  });

  it('opens a review link its provider does not serve in the browser', async () => {
    const url = 'https://github.example.com/kilo/kilo/pull/123';
    pressQuickAction(
      renderRow(findingFixture({ remediationSummary: { ...PR_OPENED, prUrl: url } }))
    );

    await vi.waitFor(() => {
      expect(mocks.openBrowser).toHaveBeenCalledWith(url);
    });
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.linkingOpenUrl).not.toHaveBeenCalled();
  });

  it('keeps an unsupported destination out of the OS opener', async () => {
    const url = 'ftp://example.com/kilo/kilo/pull/123';
    pressQuickAction(
      renderRow(findingFixture({ remediationSummary: { ...PR_OPENED, prUrl: url } }))
    );

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('common.couldNotOpen');
    });
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.linkingOpenUrl).not.toHaveBeenCalled();
  });
});
