/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Settings-overview disabled-state contract: the enable switch is disabled
// while the agent is off with no effective repo selection (the server would
// refuse an empty effective set), and re-enables once a selection exists.
// The disabled copy explains the block, and a "Select repositories" CTA is
// offered only when there are integration repos to pick from — zero repos
// stays explanatory copy only.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsOverviewScreen } from './settings-overview-screen';

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const capability = vi.hoisted(() => ({
  canManage: true,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const repositories = vi.hoisted(() => ({
  data: null as unknown[] | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const setEnabled = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));
const trackInteraction = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

const configureRows = vi.hoisted(() => ({
  rows: [] as { title: string; subtitle?: string; onPress?: () => void }[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'Switch',
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), dismiss: vi.fn(), canGoBack: vi.fn() }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Clock: 'Clock',
  Cpu: 'Cpu',
  FolderGit2: 'FolderGit2',
  Zap: 'Zap',
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSecurityAgentRepositories: () => repositories,
  useSetSecurityAgentEnabled: () => setEnabled,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/security-agent', () => ({
  getSecurityAgentPath: (scope: string, section: string) => `/security/${scope}/${section}`,
}));
vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: () => null,
}));
vi.mock('@/components/platform-error-screen', () => ({ PlatformErrorScreen: () => null }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title: string; subtitle?: string; onPress?: () => void }) => {
    configureRows.rows.push(props);
    return null;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function disabledConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isEnabled: false,
    repositorySelectionMode: 'selected',
    selectedRepositoryIds: [],
    analysisMode: 'auto',
    autoAnalysisEnabled: false,
    autoRemediationEnabled: false,
    autoDismissEnabled: false,
    newFindingNotificationsEnabled: false,
    slaNotificationsEnabled: false,
    slaEnabled: false,
    ...overrides,
  };
}

function renderScreen(): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SettingsOverviewScreen, { scope: 'personal', presentation: 'inline' })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function findSwitch(root: I): I {
  const nodes = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Switch');
  const n = nodes[0];
  if (!n) {
    throw new Error('Switch not found');
  }
  return n;
}

function renderedTexts(root: I): string[] {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

describe('SettingsOverviewScreen disabled switch', () => {
  beforeEach(() => {
    config.data = null;
    config.isLoading = false;
    config.isError = false;
    capability.canManage = true;
    repositories.data = [];
    repositories.isLoading = false;
    repositories.isError = false;
    setEnabled.isPending = false;
    setEnabled.mutate.mockClear();
    trackInteraction.mutate.mockClear();
    configureRows.rows = [];
  });

  it('disables the switch while disabled with no effective repo selection', () => {
    config.data = disabledConfig();
    repositories.data = [];
    const root = renderScreen();

    expect(findSwitch(root.root).props.value).toBe(false);
    expect(findSwitch(root.root).props.disabled).toBe(true);
  });

  it('enables the switch once a repo is selected', () => {
    config.data = disabledConfig({ selectedRepositoryIds: [1] });
    const root = renderScreen();

    expect(findSwitch(root.root).props.disabled).toBe(false);
  });

  it('enables the switch in all mode with integration repos', () => {
    config.data = disabledConfig({ repositorySelectionMode: 'all' });
    repositories.data = [{ id: 1 }];
    const root = renderScreen();

    expect(findSwitch(root.root).props.disabled).toBe(false);
  });
});

describe('SettingsOverviewScreen disabled copy and CTA', () => {
  beforeEach(() => {
    config.data = null;
    config.isLoading = false;
    config.isError = false;
    capability.canManage = true;
    repositories.data = [];
    repositories.isLoading = false;
    repositories.isError = false;
    setEnabled.isPending = false;
    setEnabled.mutate.mockClear();
    trackInteraction.mutate.mockClear();
    configureRows.rows = [];
  });

  it('shows the empty-selection copy while disabled with no effective repo', () => {
    config.data = disabledConfig();
    repositories.data = [];
    const root = renderScreen();

    expect(renderedTexts(root.root)).toContain(
      'Select at least one repository before enabling Security Agent.'
    );
  });

  it('offers the Select repositories CTA when integration repos exist', () => {
    config.data = disabledConfig();
    repositories.data = [{ id: 1 }, { id: 2 }];
    renderScreen();

    expect(configureRows.rows.map(r => r.title)).toContain('Select repositories');
  });

  it('shows explanatory copy only when there are zero integration repos', () => {
    config.data = disabledConfig();
    repositories.data = [];
    const root = renderScreen();

    expect(configureRows.rows.map(r => r.title)).not.toContain('Select repositories');
    expect(renderedTexts(root.root)).toContain(
      'Select at least one repository before enabling Security Agent.'
    );
  });

  it('does not offer the CTA to a non-manager', () => {
    capability.canManage = false;
    config.data = disabledConfig();
    repositories.data = [{ id: 1 }];
    renderScreen();

    expect(configureRows.rows.map(r => r.title)).not.toContain('Select repositories');
  });
});

describe('SettingsOverviewScreen repository query loading and error', () => {
  beforeEach(() => {
    config.data = null;
    config.isLoading = false;
    config.isError = false;
    capability.canManage = true;
    repositories.data = [];
    repositories.isLoading = false;
    repositories.isError = false;
    setEnabled.isPending = false;
    setEnabled.mutate.mockClear();
    trackInteraction.mutate.mockClear();
    configureRows.rows = [];
  });

  it('does not read a loading repo query as empty in all mode', () => {
    config.data = disabledConfig({ repositorySelectionMode: 'all' });
    repositories.data = null;
    repositories.isLoading = true;
    const root = renderScreen();

    expect(renderedTexts(root.root)).not.toContain(
      'Select at least one repository before enabling Security Agent.'
    );
  });

  it('shows a retry action when the repo query fails in all mode', () => {
    config.data = disabledConfig({ repositorySelectionMode: 'all' });
    repositories.data = null;
    repositories.isError = true;
    const root = renderScreen();

    expect(renderedTexts(root.root)).toContain('Could not load repositories');
    expect(renderedTexts(root.root)).toContain('Retry');
  });

  it('keeps the Select repositories CTA reachable when the repo query fails', () => {
    config.data = disabledConfig();
    repositories.data = null;
    repositories.isError = true;
    renderScreen();

    expect(configureRows.rows.map(r => r.title)).toContain('Select repositories');
  });
});
