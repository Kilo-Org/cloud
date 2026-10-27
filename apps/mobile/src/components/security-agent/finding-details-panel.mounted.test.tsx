// The details panel's advisory control uses the same link route as the other
// finding surfaces: a supported review link navigates in-app, everything else
// goes through the shared external-link helper.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingDetailsPanel } from './finding-details-panel';
import { type SecurityFinding } from '@/lib/security-agent';

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
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
vi.mock('@/components/ui/kv-row', () => ({ KvRow: () => null }));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: (props: { children?: unknown }) => props.children ?? null,
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: () => null,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));
vi.mock('@/lib/security-agent-copy', () => ({
  getDeadlineCopy: () => ({ label: '', detail: '' }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.join(' '),
  firstNonEmpty: (value: string | null, fallback: string) => value ?? fallback,
  parseTimestamp: () => 0,
  timeAgo: () => 'a while ago',
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getFindingLifecycleStatusPresentation: () => ({ tone: 'neutral' }),
  getFindingSeverityPresentation: () => ({ tone: 'danger' }),
  getSecurityDeadlinePresentation: () => ({ state: 'none', tone: 'neutral', icon: 'clock' }),
  getSupersedingFindingId: () => null,
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
