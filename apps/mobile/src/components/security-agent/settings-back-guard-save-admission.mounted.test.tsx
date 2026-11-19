// Regression for a duplicate config write through the unsaved-changes dialog.
// Both surfaces that can start a save — the header `SettingsSaveButton` press
// and the back guard's dialog Save — run through the same
// `useSettingsSaveFeedback().run`, whose `surface-feedback.begin()` is the
// family's one admission authority. While a header save is in flight the screen
// is still dirty, so Back opened the leave confirmation and its Save used to
// start a second `mutateAsync` alongside the first. Admission refuses the
// dialog Save with an observable sentinel rejection, so the leave is not
// replayed over an attempt that did not happen; with nothing in flight the
// dialog Save must start exactly one save and leave.

import { type ComponentType, createElement, type ReactNode, useEffect } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

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

// Both save paths are under test end to end: the real `SettingsSaveButton`
// stays mounted (NOT stubbed like the invalid-draft suite) so the header press
// and the dialog Save both flow through the real `useSettingsSaveFeedback`.
// Only the native surfaces render as stubs.
vi.mock('react-native', () => ({
  useColorScheme: () => 'light',
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
  useFocusEffect: (effect: () => void) => {
    useEffect(effect, [effect]);
  },
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: unknown }; repeat: () => void }) => void
  ) => {
    preventRemove.enabled = enabled;
    preventRemove.handler = handler;
  },
}));
// The real SettingsSaveButton reads the vendored NavigationContext. Mocking it
// with a context of this suite's own keeps a Node test off the build file and
// with no provider keeps the no-navigator degradation, so a settled save pops
// through `router.back()` — the hoisted-factory pattern of
// `settings-save-button.mounted.test.tsx` (React is only reachable through the
// dynamic import there because the factory runs above the imports).
vi.mock('expo-router/build/react-navigation/core/NavigationContext', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext<unknown>(undefined) };
});
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => save,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useMutedDisabledInk: () => '#fff',
  useThemeColors: () => ({
    mutedForeground: '#000000',
    foreground: '#000',
    primaryForeground: '#fff',
  }),
}));
vi.mock('@/lib/a11y/motion', () => ({ useMotionPolicy: () => ({ reducedMotion: false }) }));
vi.mock('@/components/ui/icons', () => ({ Clock: 'Clock', Loader2: 'Loader2' }));
// The screen's rows are the shared `PreferenceRow`, whose control is the real
// `Switch`; that component wraps the native one, which a Node suite does not
// have. The family's other suites stub it the same way.
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
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
vi.mock('@/components/ui/button', () => ({
  // A pass-through host: the real Button would drag its slot/styled stack into
  // this harness, and its Pressable would double-count. Forwarding keeps the
  // real SettingsSaveButton's props (onPress, disabled) reachable on the host.
  Button: (props: Record<string, unknown>) => createElement('Button', props),
}));
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

function pressSave(renderer: TestRenderer.ReactTestRenderer): void {
  const button = renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Button'
  );
  act(() => {
    (button.props.onPress as () => void)();
  });
}

async function flushSave(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
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

describe('back-guard Save admission on a settings screen', () => {
  const criticalField = i18n.t('securityAgent.sla.remediationDeadlineA11y', {
    label: i18n.t('common.critical'),
  });

  it('refuses the dialog Save while a header save is in flight, and does not replay the leave', async () => {
    config.data = configData;
    const renderer = mount(SlaSettingsScreen);
    expect(preventRemove.enabled).toBe(false);

    // Make the draft dirty with a valid edit through the screen's own input.
    act(() => {
      field(criticalField).onChangeText?.('5');
    });
    expect(preventRemove.enabled).toBe(true);

    // Start a header save and keep it in flight.
    const { promise: inFlight, resolve: release } = Promise.withResolvers<Record<string, never>>();
    save.mutateAsync.mockImplementation(() => inFlight);
    pressSave(renderer);
    await flushSave();
    expect(save.mutateAsync).toHaveBeenCalledOnce();

    // Back while the save is in flight: still dirty, so the guard intercepts
    // and offers the confirmation with its Save action.
    requestLeave();
    requestLeave();
    expect(preventRemove.enabled).toBe(true);
    expect(confirmationCount(renderer)).toBe(1);
    const dialog = confirmDialog.current;
    if (!dialog) {
      throw new Error('the leave confirmation was not rendered');
    }
    expect(dialog.extraAction?.label).toBe(i18n.t('securityAgent.settingsSave.saveChanges'));

    // The dialog Save must be refused by admission — exactly one write in
    // flight, no duplicate mutation — and the leave must NOT replay. The
    // refused attempt rejects with the sentinel, so the hook drops the leave
    // and keeps the draft on screen for the save still in flight. (The
    // confirmation itself dismisses as its Save is pressed — that is the
    // dialog's own behavior, before admission decides anything.)
    act(() => {
      dialog.extraAction?.onPress();
    });
    await flushSave();
    expect(save.mutateAsync).toHaveBeenCalledOnce();
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(confirmationCount(renderer)).toBe(0);

    // The header save then settles as a success; the button pops exactly once.
    release({});
    await flushSave();
    await flushSave();
    expect(router.back).toHaveBeenCalledOnce();
  });

  it('starts exactly one save from the dialog when nothing is in flight, and leaves', async () => {
    config.data = configData;
    save.mutateAsync.mockResolvedValue({});
    const renderer = mount(SlaSettingsScreen);

    act(() => {
      field(criticalField).onChangeText?.('5');
    });
    requestLeave();
    requestLeave();
    const dialog = confirmDialog.current;
    if (!dialog?.extraAction) {
      throw new Error('the leave confirmation offered no Save action');
    }

    // `dialog?.extraAction` narrowed above, so the Save action is defined.
    const saveAction = dialog.extraAction;

    act(() => {
      saveAction.onPress();
    });
    await flushSave();
    await flushSave();

    expect(save.mutateAsync).toHaveBeenCalledOnce();
    // The save succeeded, so the leave replays and the confirmation closes.
    expect(navigation.goBack).toHaveBeenCalledOnce();
    expect(confirmationCount(renderer)).toBe(0);
  });
});
