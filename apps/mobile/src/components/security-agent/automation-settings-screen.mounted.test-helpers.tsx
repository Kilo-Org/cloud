// Shared mount harness for automation-settings-screen.mounted.test.tsx. The
// mock state below lives here with its vi.mock registrations so the suite
// stays under the max-lines budget (same pattern as
// offline-banner.mounted.test-helpers.tsx). Hoisted bindings are exported at
// the bottom: an inline `export const x = vi.hoisted(...)` is un-transformable.
//
// The component the suite mocks is never imported here — the test file imports
// it and hands it to `renderScreen`.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  refetch: vi.fn(),
}));
const platformError = vi.hoisted(() => ({
  props: null as { title: string; variant?: string; message?: string; onRetry?: () => void } | null,
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
    subtitle?: string;
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
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
}));
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
const connectivity = vi.hoisted(() => ({
  committed: 'online' as 'online' | 'offline' | 'unknown',
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => connectivity.committed,
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
    subtitle?: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => {
    toggleRows.rows.push(props);
    return null;
  },
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: (props: {
    title: string;
    variant?: string;
    message?: string;
    onRetry?: () => void;
  }) => {
    platformError.props = props;
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: unknown }) => props.headerRight ?? null,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

export {
  capability,
  config,
  connectivity,
  pillGroups,
  platformError,
  save,
  saveButton,
  toastSuccess,
  toggleRows,
  trackInteraction,
};

export const APPROVAL_ROW_TITLE = 'Require approval before auto-remediation';

/** The enabled-config body the hydration and save suites read. */
export function enabledConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Mounts the screen component the test file imports, for scope 'personal'. */
export function renderScreen(
  Screen: (props: { scope: string }) => ReactNode
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Screen, { scope: 'personal' }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The "Require approval before auto-remediation" row, by its title. */
export function approvalRow(): {
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
