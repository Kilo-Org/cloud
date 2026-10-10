/* eslint-disable max-lines -- Four settings screens share the same disabled-transition regression harness. */
// Regression for the disabled-state transition on the four Security Agent
// settings screens that bounce off a disabled config. A screen that goes
// dirty and then has its config disabled externally must still render the
// pending leave confirmation: useSecurityAgentSettingsRedirect bounces the
// screen with a `replace` while the dirty guard intercepts that removal, so
// the confirmation has to stay in the rendered tree even though the screen
// body itself early-returns while disabled. Before the fix the early return
// was a bare `null`, which dropped the dialog and stranded the user with an
// unanswerable navigation.

import { type ComponentType, createElement, type ReactNode, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { AnalysisSettingsScreen } from './analysis-settings-screen';
import { AutomationSettingsScreen } from './automation-settings-screen';
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
  handler: undefined as ((options: { data: { action: unknown } }) => void) | undefined,
}));
// The child controls record their props on render so the test drives a real
// edit through the screen's own onChange/onPress props, not a fabricated
// dirty flag.
const toggleRows = vi.hoisted(() => ({
  rows: [] as {
    title: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }[],
}));
const radioOptions = vi.hoisted(() => ({
  options: [] as { accessibilityLabel?: string; onPress?: () => void }[],
}));
const confirmDialog = vi.hoisted(() => ({
  current: null as {
    cancelLabel?: string;
    confirmLabel?: string;
    extraAction?: { label: string; onPress: () => void };
    onConfirm: () => void;
    onCancel: () => void;
  } | null,
}));

// The guard is under test end to end: this suite keeps the real
// useSettingsBackGuard / useConfirmDialog, and stubs only the native surfaces
// they render through, so the screen-to-dialog wiring is exercised for real.
vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }): ReactNode => {
    radioOptions.options.push(props);
    return props.children ?? null;
  },
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: unknown } }) => void
  ) => {
    preventRemove.enabled = enabled;
    preventRemove.handler = handler;
  },
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => save,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
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
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/icons', () => ({ Brain: 'Brain', Search: 'Search', Wrench: 'Wrench' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
  radioItemA11y: ({
    label,
    checked,
    disabled,
  }: {
    label: string;
    checked: boolean;
    disabled: boolean;
  }) => ({
    accessibilityRole: 'radio',
    accessibilityLabel: label,
    accessibilityState: { checked, disabled, busy: false },
  }),
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
}));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
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
// a real parent render, not a remount, so the screen's refs and local edits
// survive the disabled transition.
function Harness({ Screen }: Readonly<{ Screen: ScreenComponent }>) {
  const [, setVersion] = useState(0);
  invalidate = () => {
    setVersion(version => version + 1);
  };
  return createElement(Screen, { scope: 'personal' });
}

// One superset config shape: every field the four screens hydrate from, so a
// single fixture drives all of them.
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
    slaEnabled: false,
    slaCriticalDays: 3,
    slaHighDays: 7,
    slaMediumDays: 14,
    slaLowDays: 30,
  };
}

function pressToggle(title: string) {
  const row = toggleRows.rows.find(candidate => candidate.title === title);
  if (!row) {
    throw new Error(`toggle row not found: ${title}`);
  }
  act(() => {
    row.onValueChange(true);
  });
}

function pressRadioOption(label: string) {
  const option = radioOptions.options.find(candidate => candidate.accessibilityLabel === label);
  if (!option) {
    throw new Error(`radio option not found: ${label}`);
  }
  act(() => {
    option.onPress?.();
  });
}

const CASES: {
  name: string;
  Screen: ScreenComponent;
  makeDirty: () => void;
  makeClean: () => void;
}[] = [
  {
    name: 'AnalysisSettingsScreen',
    Screen: AnalysisSettingsScreen,
    makeDirty: () => {
      pressRadioOption(i18n.t('securityAgent.analysisMode.deep'));
    },
    makeClean: () => {
      pressRadioOption(i18n.t('securityAgent.analysisMode.auto'));
    },
  },
  {
    name: 'AutomationSettingsScreen',
    Screen: AutomationSettingsScreen,
    makeDirty: () => {
      pressToggle(i18n.t('securityAgent.automation.enableAutoAnalysis'));
    },
    makeClean: () => {
      const row = toggleRows.rows.find(
        candidate => candidate.title === i18n.t('securityAgent.automation.enableAutoAnalysis')
      );
      if (!row) {
        throw new Error('automation toggle not found');
      }
      act(() => {
        row.onValueChange(false);
      });
    },
  },
  {
    name: 'NotificationSettingsScreen',
    Screen: NotificationSettingsScreen,
    makeDirty: () => {
      const row = toggleRows.rows[0];
      if (!row) {
        throw new Error('notification toggle not found');
      }
      act(() => {
        row.onValueChange(true);
      });
    },
    makeClean: () => {
      const row = toggleRows.rows[0];
      if (!row) {
        throw new Error('notification toggle not found');
      }
      act(() => {
        row.onValueChange(false);
      });
    },
  },
  {
    name: 'SlaSettingsScreen',
    Screen: SlaSettingsScreen,
    makeDirty: () => {
      pressToggle(i18n.t('securityAgent.sla.enableTracking'));
    },
    makeClean: () => {
      const row = toggleRows.rows.find(
        candidate => candidate.title === i18n.t('securityAgent.sla.enableTracking')
      );
      if (!row) {
        throw new Error('SLA toggle not found');
      }
      act(() => {
        row.onValueChange(false);
      });
    },
  },
];

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

function visibleConfirmationCount(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'DestructiveConfirmDialog').length;
}

const REPLACED_BY_REDIRECT = { type: 'REPLACE' };

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
  radioOptions.options = [];
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

describe.each(CASES)('$name disabled-while-dirty', ({ Screen, makeDirty, makeClean }) => {
  it('keeps the leave confirmation on screen and resolves Discard / Keep editing', () => {
    config.data = enabledConfig();
    const renderer = mount(Screen);

    // A clean screen lets navigation through untouched.
    expect(preventRemove.enabled).toBe(false);

    // A real local edit arms the dirty guard.
    makeDirty();
    expect(preventRemove.enabled).toBe(true);

    // The config is disabled elsewhere; the screen's redirect fires, but the
    // guard has not been asked to remove the screen yet.
    config.data = { ...enabledConfig(), isEnabled: false };
    act(() => {
      invalidate();
    });
    expect(router.replaced).toHaveLength(1);
    expect(router.replaced[0]).toContain('security-agent/personal/settings');
    expect(visibleConfirmationCount(renderer)).toBe(0);

    // The navigator asks the dirty guard to remove the screen for that
    // redirect; the intercepted leave must surface a visible choice even
    // though the disabled body early-returns.
    act(() => {
      preventRemove.handler?.({ data: { action: REPLACED_BY_REDIRECT } });
    });
    expect(visibleConfirmationCount(renderer)).toBe(1);
    const dialog = confirmDialog.current;
    if (!dialog) {
      throw new Error('the leave confirmation was not rendered while disabled');
    }
    expect(dialog.cancelLabel).toBe(i18n.t('common.keepEditing'));
    expect(dialog.confirmLabel).toBe(i18n.t('common.discard'));
    expect(dialog.extraAction?.label).toBe(i18n.t('securityAgent.settingsSave.saveChanges'));

    // Keep editing: dismisses the confirmation and stays put.
    act(() => {
      dialog.onCancel();
    });
    expect(visibleConfirmationCount(renderer)).toBe(0);
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(renderer.root.findAll(node => String(node.type) === 'SettingsSaveButton')).toHaveLength(
      1
    );

    // Discard: replays the captured navigation and leaves.
    act(() => {
      preventRemove.handler?.({ data: { action: REPLACED_BY_REDIRECT } });
    });
    expect(visibleConfirmationCount(renderer)).toBe(1);
    const reopened = confirmDialog.current;
    if (!reopened) {
      throw new Error('the leave confirmation did not reopen');
    }
    act(() => {
      reopened.onConfirm();
    });
    expect(navigation.dispatch).toHaveBeenCalledWith(REPLACED_BY_REDIRECT);
  });
  it('retries the disabled redirect when an unsaved edit is undone', () => {
    config.data = enabledConfig();
    const renderer = mount(Screen);
    makeDirty();
    config.data = { ...enabledConfig(), isEnabled: false };
    act(() => {
      invalidate();
    });
    act(() => preventRemove.handler?.({ data: { action: REPLACED_BY_REDIRECT } }));
    act(() => confirmDialog.current?.onCancel());
    expect(renderer.root.findAll(node => String(node.type) === 'SettingsSaveButton')).toHaveLength(
      1
    );
    expect(router.replaced).toHaveLength(1);
    makeClean();
    expect(preventRemove.enabled).toBe(false);
    expect(router.replaced).toHaveLength(2);
  });
});
