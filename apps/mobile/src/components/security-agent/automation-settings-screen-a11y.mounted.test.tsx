// Automation-settings accessible-name contract: the Auto analysis and Auto
// remediation sections share the same visible copy for their severity group
// and their "Include existing findings" switch, so each control's accessible
// name carries its section. The visible copy must not change.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AutomationSettingsScreen } from './automation-settings-screen';

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const capability = vi.hoisted(() => ({ canManage: true }));
const save = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
}));
const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));

const toggleRows = vi.hoisted(() => ({
  rows: [] as {
    title: string;
    accessibilityLabel?: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }[],
}));
const pillGroups = vi.hoisted(() => ({
  groups: [] as { label: string; accessibilityLabel?: string }[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getSettingsDirtyState: () => 'clean',
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => save,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSecurityAgentSettingsRedirect: () => undefined,
  useSettingsBackGuard: () => ({
    onBack: () => undefined,
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
}));
vi.mock('@/components/security-agent/settings-pill-group', () => ({
  PillGroup: (props: { label: string; accessibilityLabel?: string }) => {
    pillGroups.groups.push({ label: props.label, accessibilityLabel: props.accessibilityLabel });
    return null;
  },
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: () => null,
}));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: (props: {
    title: string;
    accessibilityLabel?: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => {
    toggleRows.rows.push(props);
    return null;
  },
}));
vi.mock('@/components/platform-error-screen', () => ({ PlatformErrorScreen: () => null }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: unknown }) => props.headerRight ?? null,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

const SWITCH_TITLE = 'Include existing findings';
const GROUP_LABEL = 'Minimum severity';

function bothSectionsConfig(): Record<string, unknown> {
  return {
    isEnabled: true,
    autoAnalysisEnabled: true,
    autoAnalysisMinSeverity: 'high',
    autoAnalysisIncludeExisting: false,
    autoRemediationEnabled: true,
    autoRemediationMinSeverity: 'high',
    autoRemediationIncludeExisting: false,
    autoRemediationRequireApproval: true,
    autoDismissEnabled: false,
    autoDismissConfidenceThreshold: 'high',
  };
}

function renderScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(AutomationSettingsScreen, { scope: 'personal' })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('AutomationSettingsScreen accessible names', () => {
  beforeEach(() => {
    capability.canManage = true;
    save.mutateAsync.mockReset();
    trackInteraction.mutate.mockClear();
    toggleRows.rows = [];
    pillGroups.groups = [];
    config.data = bothSectionsConfig();
    config.isLoading = false;
    config.isError = false;
  });

  // Regression: the two sections rendered the same switch, so a screen reader
  // announced "Include existing findings" twice with nothing to say which
  // section each one changes.
  it('names each include-existing switch with its section', () => {
    renderScreen();
    const switches = toggleRows.rows.filter(row => row.title === SWITCH_TITLE);
    const names = switches.map(row => row.accessibilityLabel);

    expect(switches).toHaveLength(2);
    expect(names).toEqual([
      'Include existing findings, Auto analysis',
      'Include existing findings, Auto remediation',
    ]);
    expect(new Set(names).size).toBe(2);
  });

  // Same defect on the severity groups: one visible label, two radiogroups.
  it('names each severity group with its section and keeps the visible label', () => {
    renderScreen();
    const names = pillGroups.groups.map(group => group.accessibilityLabel);

    expect(pillGroups.groups).toHaveLength(2);
    expect(names).toEqual([
      'Minimum severity, Auto analysis',
      'Minimum severity, Auto remediation',
    ]);
    expect(new Set(names).size).toBe(2);
    for (const group of pillGroups.groups) {
      expect(group.label).toBe(GROUP_LABEL);
    }
  });
});
