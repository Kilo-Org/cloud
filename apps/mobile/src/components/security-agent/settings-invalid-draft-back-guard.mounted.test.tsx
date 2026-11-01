// Regression for back navigation on a Security Agent settings draft whose only
// change is invalid. The save payload carries the saved value in place of an
// invalid day, and the dirty check used to read that same payload: the screen
// therefore classified as clean, `usePreventRemove` stayed disabled, and
// Back left the screen with no "Unsaved changes" confirmation, dropping the
// typed text. The guard has to read the draft the user can see.

import { type ComponentType, createElement, type ReactNode, useState } from 'react';
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
const capability = vi.hoisted(() => ({ canManage: true }));
const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));
const router = vi.hoisted(() => ({
  replaced: [] as unknown[],
  replace: (href: unknown) => {
    router.replaced.push(href);
  },
  back: vi.fn(),
  push: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn() }));
const preventRemove = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as
    | ((options: { data: { action: unknown }; repeat: () => void }) => void)
    | undefined,
}));
// The child controls record their props on render so the test drives a real
// edit through the screen's own onValueChange/onChangeText props, not a
// fabricated dirty flag.
const toggleRows = vi.hoisted(() => ({
  rows: [] as {
    title: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }[],
}));
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
vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
  Pressable: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
}));
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
  useSecurityAgentCapability: () => capability,
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

type ScreenComponent = ComponentType<{ scope: string }>;

let invalidate: () => void = () => undefined;

// Re-renders the mounted screen the way a fresh config from the query would:
// a real parent render, not a remount, so the screen's local draft survives.
function Harness({ Screen }: Readonly<{ Screen: ScreenComponent }>) {
  const [, setVersion] = useState(0);
  invalidate = () => {
    setVersion(version => version + 1);
  };
  return createElement(Screen, { scope: 'personal' });
}

function enabledConfig() {
  return {
    isEnabled: true,
    triageModelSlug: 'vendor/triage',
    analysisModelSlug: 'vendor/analysis',
    remediationModelSlug: 'vendor/remediation',
    analysisMode: 'auto',
    autoAnalysisEnabled: false,
    autoAnalysisMinSeverity: 'all',
    autoAnalysisIncludeExisting: false,
    autoRemediationEnabled: false,
    autoRemediationMinSeverity: 'all',
    autoRemediationIncludeExisting: false,
    autoRemediationRequireApproval: true,
    autoDismissEnabled: false,
    autoDismissConfidenceThreshold: 'high',
    newFindingNotificationsEnabled: false,
    newFindingNotificationMinSeverity: 'low',
    slaNotificationsEnabled: false,
    slaNotificationMinSeverity: 'low',
    slaNotificationWarningDays: 7,
    slaEnabled: true,
    slaCriticalDays: 3,
    slaHighDays: 7,
    slaMediumDays: 14,
    slaLowDays: 30,
  };
}

function findToggle(title: string) {
  const row = toggleRows.rows.find(candidate => candidate.title === title);
  if (!row) {
    throw new Error(`toggle row not found: ${title}`);
  }
  return row;
}

function field(label: string) {
  const input = inputs.fields.find(candidate => candidate.accessibilityLabel === label);
  if (!input?.onChangeText) {
    throw new Error(`input not found: ${label}`);
  }
  return input;
}

const CRITICAL_FIELD = i18n.t('securityAgent.sla.remediationDeadlineA11y', {
  label: i18n.t('common.critical'),
});
const LEAD_TIME_FIELD = i18n.t('securityAgent.notifications.slaLeadTimeAccessibility');

const mounts: TestRenderer.ReactTestRenderer[] = [];

function mount(Screen: ScreenComponent) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, { Screen }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounts.push(renderer);
  return renderer;
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
  capability.canManage = true;
  save.isPending = false;
  save.mutateAsync.mockReset();
  save.mutateAsync.mockResolvedValue({});
  trackInteraction.mutate.mockClear();
  router.replaced = [];
  router.back.mockReset();
  router.push.mockReset();
  navigation.dispatch.mockReset();
  navigation.goBack.mockReset();
  preventRemove.enabled = false;
  preventRemove.handler = undefined;
  toggleRows.rows = [];
  inputs.fields = [];
  confirmDialog.current = null;
  invalidate = () => undefined;
});

afterEach(() => {
  for (const renderer of mounts) {
    act(() => {
      renderer.unmount();
    });
  }
  mounts.length = 0;
});

describe('SLA settings back guard', () => {
  it('offers discard and keep editing for a draft whose only change is invalid', () => {
    config.data = enabledConfig();
    const renderer = mount(SlaSettingsScreen);
    expect(preventRemove.enabled).toBe(false);

    act(() => {
      field(CRITICAL_FIELD).onChangeText?.('366');
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

  it('offers save for a valid edit and lets a clean screen leave untouched', () => {
    config.data = enabledConfig();
    const renderer = mount(SlaSettingsScreen);

    act(() => {
      field(CRITICAL_FIELD).onChangeText?.('5');
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
      field(CRITICAL_FIELD).onChangeText?.('3');
    });
    expect(preventRemove.enabled).toBe(false);
    expect(confirmationCount(renderer)).toBe(0);
  });
});

describe('Notification settings back guard', () => {
  // Baseline already has SLA notifications on, so the typed lead time is the
  // only change and nothing else can make the screen dirty.
  function slaNotificationsOn() {
    return { ...enabledConfig(), slaNotificationsEnabled: true };
  }

  it('offers discard and keep editing for an invalid-only lead time', () => {
    config.data = slaNotificationsOn();
    const renderer = mount(NotificationSettingsScreen);
    expect(preventRemove.enabled).toBe(false);

    act(() => {
      field(LEAD_TIME_FIELD).onChangeText?.('366');
    });
    expect(preventRemove.enabled).toBe(true);

    requestLeave();
    expect(confirmationCount(renderer)).toBe(1);
    const dialog = confirmDialog.current;
    if (!dialog) {
      throw new Error('the leave confirmation was not rendered');
    }
    expect(dialog.confirmLabel).toBe(i18n.t('common.discard'));
    expect(dialog.extraAction).toBeUndefined();
  });

  it('offers save for a valid lead time', () => {
    config.data = slaNotificationsOn();
    mount(NotificationSettingsScreen);

    act(() => {
      field(LEAD_TIME_FIELD).onChangeText?.('10');
    });
    requestLeave();
    expect(confirmDialog.current?.extraAction?.label).toBe(
      i18n.t('securityAgent.settingsSave.saveChanges')
    );
  });
});
