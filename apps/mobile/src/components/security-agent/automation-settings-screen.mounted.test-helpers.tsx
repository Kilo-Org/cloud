// Mock registrations for automation-settings-screen.mounted.test.tsx. They live
// here so the suite stays under the max-lines budget (same pattern as
// offline-banner.mounted.test-helpers.tsx). The suite imports this module
// FIRST, before any other import, so the registrations are in place before the
// screen module evaluates.
//
// The component the suite mocks is never imported here: the test file imports
// it and drives it through the exported mock state.

import { vi } from 'vitest';
import { type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';

type PreferenceRowProps = {
  title: string;
  accessibilityLabel?: string;
  subtitle?: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
};

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  error: null as unknown,
  refetch: vi.fn(),
}));
const retryConfig = vi.hoisted(() => ({
  retry: vi.fn(),
  isRetrying: false,
}));
const capability = vi.hoisted(() => ({
  canManage: true,
  status: 'allowed' as 'loading' | 'error' | 'denied' | 'allowed',
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
}));
const settingsRecovery = vi.hoisted(() => ({
  retry: vi.fn(),
  isRetrying: false,
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
  rows: [] as PreferenceRowProps[],
}));
const pillGroups = vi.hoisted(() => ({
  groups: [] as { label: string; accessibilityLabel?: string }[],
}));
const saveButton = vi.hoisted(() => ({
  onSave: null as (() => Promise<void>) | null,
}));
const connectivity = vi.hoisted(() => ({
  committed: 'online' as 'online' | 'offline' | 'unknown',
}));
const platformError = vi.hoisted(() => ({
  props: null as {
    title: string;
    errorTitle?: string;
    variant?: string;
    message?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  } | null,
}));
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  CircleCheck: 'CircleCheck',
  Clock: 'Clock',
  GitPullRequest: 'GitPullRequest',
  ScanSearch: 'ScanSearch',
  Trash2: 'Trash2',
}));
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
  useRetrySecurityAgentConfig: () => retryConfig,
  useRetrySecurityAgentSettings: () => settingsRecovery,
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
vi.mock('@/components/ui/preference-row', () => ({
  PreferenceRow: (props: PreferenceRowProps) => {
    toggleRows.rows.push(props);
    return null;
  },
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: (props: {
    title: string;
    errorTitle?: string;
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
vi.mock('@/components/security-agent/settings-recovery-status', () => ({
  // A host string, so the suite can both count the status and read the props
  // its Retry is wired through.
  SettingsRecoveryStatus: 'SettingsRecoveryStatus',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

// The permission-recovery row the screen renders, found as the host element its
// stub draws, so a case can tell one from none and read the message it carries.
function recoveryStatuses(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node => String(node.type) === 'SettingsRecoveryStatus');
}

// The copy the screen drew, so a case can name the permission note it kept.
function textContents(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    );
}

const APPROVAL_ROW_TITLE = 'Require approval before auto-remediation';

// The enabled draft the screen hydrates from, one object so a case names only
// the fields its state is about.
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

// The approval row the screen drew, read from the captured rows so a case
// asserts on what rendered rather than on the fixture it set.
function approvalRow(): PreferenceRowProps {
  const row = toggleRows.rows.find(r => r.title === APPROVAL_ROW_TITLE);
  if (!row) {
    throw new Error('approval toggle row not found');
  }
  return row;
}

export {
  approvalRow,
  capability,
  config,
  connectivity,
  enabledConfig,
  pillGroups,
  platformError,
  recoveryStatuses,
  retryConfig,
  save,
  saveButton,
  settingsRecovery,
  textContents,
  toastSuccess,
  toggleRows,
  trackInteraction,
};
