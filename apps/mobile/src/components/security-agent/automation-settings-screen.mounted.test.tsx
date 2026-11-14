// Automation-settings approval-gate contract: the "Require approval before
// auto-remediation" toggle hydrates from the loaded config, persists through
// the save patch object, and renders disabled for read-only viewers.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AutomationSettingsScreen } from './automation-settings-screen';

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const capability = vi.hoisted(() => ({
  canManage: true,
}));
const save = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
  options: undefined as { announceSaved?: boolean } | undefined,
}));
const trackInteraction = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

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
const saveButton = vi.hoisted(() => ({
  onSave: null as (() => Promise<void>) | null,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
}));
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: (message: string) => toastSuccess(message), error: vi.fn() },
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  getSettingsDirtyState: () => 'clean',
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: (_scope: string, options?: { announceSaved?: boolean }) => {
    save.options = options;
    return save;
  },
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
    pillGroups.groups.push(props);
    return null;
  },
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: (props: { onSave: () => Promise<void> }) => {
    saveButton.onSave = props.onSave;
    return null;
  },
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

const APPROVAL_ROW_TITLE = 'Require approval before auto-remediation';

function enabledConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isEnabled: true,
    autoAnalysisEnabled: false,
    autoAnalysisMinSeverity: 'high',
    autoAnalysisIncludeExisting: false,
    autoRemediationEnabled: true,
    autoRemediationMinSeverity: 'high',
    autoRemediationIncludeExisting: false,
    autoRemediationRequireApproval: true,
    autoDismissEnabled: false,
    autoDismissConfidenceThreshold: 'high',
    ...overrides,
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

function approvalRow(): {
  title: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
} {
  const row = toggleRows.rows.find(r => r.title === APPROVAL_ROW_TITLE);
  if (!row) {
    throw new Error('approval toggle row not found');
  }
  return row;
}

describe('AutomationSettingsScreen approval gate', () => {
  beforeEach(() => {
    config.data = null;
    config.isLoading = false;
    config.isError = false;
    capability.canManage = true;
    save.isPending = false;
    save.mutateAsync.mockReset();
    save.mutateAsync.mockResolvedValue({});
    trackInteraction.mutate.mockClear();
    toggleRows.rows = [];
    pillGroups.groups = [];
    saveButton.onSave = null;
    toastSuccess.mockClear();
  });

  it('hydrates the approval toggle from the loaded config', () => {
    config.data = enabledConfig({ autoRemediationRequireApproval: false });
    renderScreen();

    expect(approvalRow().value).toBe(false);
  });

  it('persists the approval toggle through the save patch object', async () => {
    config.data = enabledConfig({ autoRemediationRequireApproval: true });
    renderScreen();

    act(() => {
      approvalRow().onValueChange(false);
    });
    await act(async () => {
      await saveButton.onSave?.();
    });

    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ autoRemediationRequireApproval: false })
    );
  });

  it.each([
    // The queued count is this screen's own outcome; without one the screen
    // still confirms the save, so the shared hook must not announce as well.
    [{ existingFindingsQueuedCount: 3 }, 'securityAgent.automation.queued'],
    [{}, 'securityAgent.settingsSave.saved'],
  ])('announces one confirmation for a save result of %j', async (result, expectedKey) => {
    config.data = enabledConfig();
    save.mutateAsync.mockResolvedValue(result);
    renderScreen();

    await act(async () => {
      await saveButton.onSave?.();
    });

    expect(save.options?.announceSaved).toBe(false);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0]?.[0]).toBe(
      i18n.t(expectedKey, { count: 3, displayCount: '3' })
    );
  });

  it('renders the approval toggle disabled for read-only viewers', () => {
    capability.canManage = false;
    config.data = enabledConfig();
    renderScreen();

    expect(approvalRow().disabled).toBe(true);
  });

  it('names each repeated control with the section it belongs to', () => {
    config.data = enabledConfig({ autoAnalysisEnabled: true, autoRemediationEnabled: true });
    renderScreen();

    const analysisSection = i18n.t('securityAgent.automation.autoAnalysis');
    const remediationSection = i18n.t('securityAgent.automation.autoRemediation');
    const includeTitle = i18n.t('securityAgent.automation.includeExistingFindings');
    const severityTitle = i18n.t('securityAgent.automation.minimumSeverity');

    const includeNames = toggleRows.rows
      .filter(row => row.title === includeTitle)
      .map(row => row.accessibilityLabel);
    expect(includeNames).toHaveLength(2);
    const includeAnalysis = includeNames.filter(name => name?.includes(analysisSection));
    const includeRemediation = includeNames.filter(name => name?.includes(remediationSection));
    expect(includeAnalysis).toHaveLength(1);
    expect(includeRemediation).toHaveLength(1);

    const severityGroups = pillGroups.groups.filter(group => group.label === severityTitle);
    expect(severityGroups).toHaveLength(2);
    const severityNames = severityGroups.map(group => group.accessibilityLabel);
    const severityAnalysis = severityNames.filter(name => name?.includes(analysisSection));
    const severityRemediation = severityNames.filter(name => name?.includes(remediationSection));
    expect(severityAnalysis).toHaveLength(1);
    expect(severityRemediation).toHaveLength(1);

    const names = [...includeNames, ...severityNames];
    expect(new Set(names).size).toBe(4);
  });
});
