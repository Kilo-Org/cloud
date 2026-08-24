/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Automation-settings approval-gate contract: the "Require approval before
// auto-remediation" toggle hydrates from the loaded config, persists through
// the save patch object, and renders disabled for read-only viewers.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
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
}));
const trackInteraction = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

const toggleRows = vi.hoisted(() => ({
  rows: [] as {
    title: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }[],
}));
const saveButton = vi.hoisted(() => ({
  onSave: null as (() => Promise<void>) | null,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
}));
vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
  useSettingsBackGuard: () => ({ onBack: () => undefined, skipNextGuardRef: { current: false } }),
}));
vi.mock('@/components/security-agent/settings-pill-group', () => ({
  PillGroup: () => null,
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
    saveButton.onSave = null;
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

  it('renders the approval toggle disabled for read-only viewers', () => {
    capability.canManage = false;
    config.data = enabledConfig();
    renderScreen();

    expect(approvalRow().disabled).toBe(true);
  });
});
