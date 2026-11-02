// The SLA lead-time field is read-only for a member who cannot manage the
// Security Agent, and its announced state has to agree with that: the field
// carries `editable={false}`, so it must also report itself disabled, the way
// the SLA settings screen's day fields and this screen's switches and severity
// options do. A member otherwise hears an editable text field that opens no
// keyboard.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { NotificationSettingsScreen } from './notification-settings-screen';

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const capability = vi.hoisted(() => ({ canManage: true }));
const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));
const inputs = vi.hoisted(() => ({
  fields: [] as {
    accessibilityLabel?: string;
    editable?: boolean;
    accessibilityState?: { disabled?: boolean };
  }[],
}));

vi.mock('react-native', () => ({ View: 'View' }));
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
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/components/ui/input', () => ({
  Input: (props: {
    accessibilityLabel?: string;
    editable?: boolean;
    accessibilityState?: { disabled?: boolean };
  }) => {
    inputs.fields.push(props);
    return null;
  },
}));
vi.mock('@/components/security-agent/settings-pill-group', () => ({ PillGroup: () => null }));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: () => null,
}));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({ ToggleRow: () => null }));
vi.mock('@/components/platform-error-screen', () => ({ PlatformErrorScreen: () => null }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

const LEAD_TIME_LABEL = 'securityAgent.notifications.slaLeadTimeLabel';

function enabledConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isEnabled: true,
    newFindingNotificationsEnabled: false,
    newFindingNotificationMinSeverity: 'low',
    slaNotificationsEnabled: true,
    slaNotificationMinSeverity: 'high',
    slaNotificationWarningDays: 5,
    ...overrides,
  };
}

function renderScreen(): void {
  act(() => {
    TestRenderer.create(createElement(NotificationSettingsScreen, { scope: 'organization-1' }));
  });
}

/** The SLA lead-time field, the only numeric input this screen renders. */
function leadTimeField(): {
  accessibilityLabel?: string;
  editable?: boolean;
  accessibilityState?: { disabled?: boolean };
} {
  const field = inputs.fields.find(
    candidate => candidate.accessibilityLabel === i18n.t(LEAD_TIME_LABEL)
  );
  if (!field) {
    throw new Error('lead-time field not found');
  }
  return field;
}

describe('NotificationSettingsScreen read-only state', () => {
  beforeEach(() => {
    config.data = enabledConfig();
    config.isLoading = false;
    config.isError = false;
    capability.canManage = true;
    inputs.fields = [];
  });

  it('reports the lead-time field as disabled for a read-only member', () => {
    capability.canManage = false;
    renderScreen();

    expect(leadTimeField().editable).toBe(false);
    expect(leadTimeField().accessibilityState).toEqual({ disabled: true });
  });

  it('keeps the lead-time field editable and enabled for a manager', () => {
    renderScreen();

    expect(leadTimeField().editable).toBe(true);
    expect(leadTimeField().accessibilityState).toEqual({ disabled: false });
  });
});
