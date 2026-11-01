// Regression for back navigation on a Security Agent settings draft whose only
// change is invalid. The save payload carries the saved value in place of an
// invalid day, and the dirty check used to read that same payload: the screen
// therefore classified as clean, `usePreventRemove` stayed disabled, and Back
// left the screen with no "Unsaved changes" confirmation, dropping the typed
// text. The guard has to read the draft the user can see.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { NotificationSettingsScreen } from './notification-settings-screen';
import { SlaSettingsScreen } from './sla-settings-screen';

const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn() }));
const navigation = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn() }));
const preventRemove = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as
    | ((options: { data: { action: unknown }; repeat: () => void }) => void)
    | undefined,
}));
// The day inputs record their props on render so the test drives a real edit
// through the screen's own onChangeText, not a fabricated dirty flag.
const inputs = vi.hoisted(() => ({
  fields: [] as {
    accessibilityLabel?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
  }[],
}));
const confirmDialog = vi.hoisted(() => ({
  current: null as null | {
    cancelLabel?: string;
    confirmLabel?: string;
    extraAction?: { label: string; onPress: () => void };
    onConfirm: () => void;
    onCancel: () => void;
  },
}));

// The guard is under test end to end: this suite keeps the real
// useSettingsBackGuard / useConfirmDialog and the real getSettingsDirtyState,
// and stubs only the native surfaces they render through.
vi.mock('react-native', () => ({ View: 'View', Alert: { alert: vi.fn() } }));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: unknown }; repeat: () => void }) => void
  ) => {
    preventRemove.enabled = enabled;
    preventRemove.handler = handler;
  },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => save,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@rn-primitives/dialog', () => ({
  Action: 'AlertDialog.Action',
  Cancel: 'AlertDialog.Cancel',
  Content: 'AlertDialog.Content',
  Description: 'AlertDialog.Description',
  Overlay: 'AlertDialog.Overlay',
  Portal: 'AlertDialog.Portal',
  Root: 'AlertDialog.Root',
  Title: 'AlertDialog.Title',
}));
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: (props: {
    cancelLabel?: string;
    confirmLabel?: string;
    extraAction?: { label: string; onPress: () => void };
    onConfirm: () => void;
    onCancel: () => void;
  }) => {
    confirmDialog.current = props;
    // The host element keeps the confirmation queryable by visibility, so
    // "no dialog drawn" stays distinguishable from "never requested".
    return createElement('DestructiveConfirmDialog');
  },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({
  Input: (props: {
    accessibilityLabel?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
  }) => {
    inputs.fields.push(props);
    return null;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }): ReactNode => props.headerRight ?? null,
}));
vi.mock('@/components/security-agent/settings-pill-group', () => ({ PillGroup: 'PillGroup' }));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: 'SettingsSaveButton',
}));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({ ToggleRow: 'ToggleRow' }));

const mounted: TestRenderer.ReactTestRenderer[] = [];

function mount(Screen: ComponentType<{ scope: string }>) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Screen, { scope: 'personal' }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

// SLA tracking and its warning notifications start enabled, so a typed day is
// the only change any case makes.
const configData = {
  isEnabled: true,
  newFindingNotificationsEnabled: false,
  newFindingNotificationMinSeverity: 'low',
  slaNotificationsEnabled: true,
  slaNotificationMinSeverity: 'low',
  slaNotificationWarningDays: 7,
  slaEnabled: true,
  slaCriticalDays: 3,
  slaHighDays: 7,
  slaMediumDays: 14,
  slaLowDays: 30,
};

function field(accessibilityLabel: string) {
  const input = inputs.fields.find(
    candidate => candidate.accessibilityLabel === accessibilityLabel
  );
  if (!input?.onChangeText) {
    throw new Error(`input not found: ${accessibilityLabel}`);
  }
  return input;
}

function confirmationCount(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'DestructiveConfirmDialog').length;
}

const GO_BACK = { type: 'GO_BACK' };

function requestLeave() {
  act(() => {
    preventRemove.handler?.({
      data: { action: GO_BACK },
      repeat: () => {
        navigation.goBack();
      },
    });
  });
}

beforeEach(() => {
  config.data = null;
  config.isLoading = false;
  config.isError = false;
  save.isPending = false;
  save.mutateAsync.mockReset();
  save.mutateAsync.mockResolvedValue({});
  router.replace.mockReset();
  navigation.goBack.mockReset();
  preventRemove.enabled = false;
  preventRemove.handler = undefined;
  inputs.fields = [];
  confirmDialog.current = null;
});

afterEach(() => {
  for (const renderer of mounted) {
    act(() => {
      renderer.unmount();
    });
  }
  mounted.length = 0;
});

describe('a settings draft whose only change is invalid', () => {
  const criticalField = i18n.t('securityAgent.sla.remediationDeadlineA11y', {
    label: i18n.t('common.critical'),
  });
  const leadTimeField = i18n.t('securityAgent.notifications.slaLeadTimeLabel');

  it('confirms Back on the SLA screen and offers discard or keep editing', () => {
    config.data = configData;
    const renderer = mount(SlaSettingsScreen);
    expect(preventRemove.enabled).toBe(false);

    act(() => {
      field(criticalField).onChangeText?.('366');
    });
    expect(preventRemove.enabled).toBe(true);

    requestLeave();
    expect(confirmationCount(renderer)).toBe(1);
    const dialog = confirmDialog.current;
    if (!dialog) {
      throw new Error('the leave confirmation was not rendered');
    }
    expect(dialog.cancelLabel).toBe(i18n.t('common.keepEditing'));
    expect(dialog.confirmLabel).toBe(i18n.t('common.discard'));
    // Nothing valid to persist, so the confirmation must not offer Save.
    expect(dialog.extraAction).toBeUndefined();

    act(() => {
      dialog.onCancel();
    });
    expect(confirmationCount(renderer)).toBe(0);
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it('still offers Save for a valid edit and lets the restored draft leave untouched', () => {
    config.data = configData;
    const renderer = mount(SlaSettingsScreen);

    act(() => {
      field(criticalField).onChangeText?.('5');
    });
    requestLeave();
    expect(confirmDialog.current?.extraAction?.label).toBe(
      i18n.t('securityAgent.settingsSave.saveChanges')
    );
    act(() => {
      confirmDialog.current?.onCancel();
    });

    // Back to the saved value: the screen is clean again and Back is free.
    act(() => {
      field(criticalField).onChangeText?.('3');
    });
    expect(preventRemove.enabled).toBe(false);
    expect(confirmationCount(renderer)).toBe(0);
  });

  it('confirms Back on the notifications screen for an invalid-only lead time', () => {
    config.data = configData;
    const renderer = mount(NotificationSettingsScreen);
    expect(preventRemove.enabled).toBe(false);

    act(() => {
      field(leadTimeField).onChangeText?.('366');
    });
    expect(preventRemove.enabled).toBe(true);

    requestLeave();
    expect(confirmationCount(renderer)).toBe(1);
    expect(confirmDialog.current?.confirmLabel).toBe(i18n.t('common.discard'));
    expect(confirmDialog.current?.extraAction).toBeUndefined();
  });

  it('offers Save on the notifications screen for a valid lead time', () => {
    config.data = configData;
    mount(NotificationSettingsScreen);

    act(() => {
      field(leadTimeField).onChangeText?.('10');
    });
    requestLeave();
    expect(confirmDialog.current?.extraAction?.label).toBe(
      i18n.t('securityAgent.settingsSave.saveChanges')
    );
  });
});
