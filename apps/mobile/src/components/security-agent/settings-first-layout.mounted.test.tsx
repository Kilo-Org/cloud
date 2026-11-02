// Regression for the four Security Agent settings screens that hydrate their
// draft from the loaded config in an effect. A body painted before that
// hydration shows the default draft and then moves every control below it once
// the config's pickers and rows appear — the layout shift the Android design
// gate measured on the notification screen. Each screen must paint its body
// only after the draft already carries the config's values, so the first body
// frame is the settled one.

import { type ComponentType, createElement, type ReactNode, useEffect } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { AnalysisSettingsScreen } from './analysis-settings-screen';
import { AutomationSettingsScreen } from './automation-settings-screen';
import { NotificationSettingsScreen } from './notification-settings-screen';
import { SlaSettingsScreen } from './sla-settings-screen';

type Frame = {
  toggles: boolean[];
  pickers: (string | null)[];
  radios: { label: string; checked: boolean }[];
  rows: (string | undefined)[];
  inputs: string[];
};

type Event =
  | { kind: 'frame' }
  | { kind: 'toggle'; value: boolean }
  | { kind: 'picker'; value: string | null }
  | { kind: 'radio'; label: string; checked: boolean }
  | { kind: 'row'; subtitle?: string }
  | { kind: 'input'; defaultValue: string };

const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
// Every control the draft drives records its rendered props during its render
// pass, and the scroll view opens a new frame when it renders. Slicing the
// events turns them into one frame per body render.
const record = vi.hoisted(() => ({ events: [] as Event[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }): ReactNode => children ?? null,
  Alert: { alert: vi.fn() },
  Pressable: (props: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean };
    onPress?: () => void;
  }): ReactNode => {
    if (props.accessibilityRole === 'radio' && props.accessibilityLabel !== undefined) {
      record.events.push({
        kind: 'radio',
        label: props.accessibilityLabel,
        checked: props.accessibilityState?.checked === true,
      });
    }
    return props.children ?? null;
  },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn() }),
  useNavigation: () => ({ dispatch: vi.fn(), goBack: vi.fn() }),
  useFocusEffect: (effect: () => void) => {
    useEffect(effect, [effect]);
  },
  usePreventRemove: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => save,
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
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
  useThemeColors: () => ({ mutedForeground: '#000000', primary: '#000000' }),
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
  DestructiveConfirmDialog: 'DestructiveConfirmDialog',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({
  Input: (props: { defaultValue?: string }): null => {
    record.events.push({ kind: 'input', defaultValue: props.defaultValue ?? '' });
    return null;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { subtitle?: string }): null => {
    record.events.push({ kind: 'row', subtitle: props.subtitle });
    return null;
  },
}));
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
  TabScreenScrollView: (props: { children?: ReactNode }): ReactNode => {
    record.events.push({ kind: 'frame' });
    return props.children ?? null;
  },
}));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/security-agent/settings-pill-group', () => ({
  PillGroup: (props: { value: string | null }): null => {
    record.events.push({ kind: 'picker', value: props.value });
    return null;
  },
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: 'SettingsSaveButton',
}));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: (props: { value: boolean }): null => {
    record.events.push({ kind: 'toggle', value: props.value });
    return null;
  },
}));

// One superset config: every field the four screens hydrate from, with every
// optional group on, so each screen's revealed controls are on the first frame.
function enabledConfig() {
  return {
    isEnabled: true,
    triageModelSlug: 'vendor/triage',
    analysisModelSlug: 'vendor/analysis',
    remediationModelSlug: 'vendor/remediation',
    analysisMode: 'deep',
    autoAnalysisEnabled: true,
    autoAnalysisMinSeverity: 'high',
    autoAnalysisIncludeExisting: true,
    autoRemediationEnabled: true,
    autoRemediationMinSeverity: 'high',
    autoRemediationIncludeExisting: true,
    autoRemediationRequireApproval: true,
    autoDismissEnabled: true,
    autoDismissConfidenceThreshold: 'high',
    newFindingNotificationsEnabled: true,
    newFindingNotificationMinSeverity: 'high',
    slaNotificationsEnabled: true,
    slaNotificationMinSeverity: 'high',
    slaNotificationWarningDays: 7,
    slaEnabled: true,
    slaCriticalDays: 3,
    slaHighDays: 7,
    slaMediumDays: 14,
    slaLowDays: 30,
  };
}

function frames(events: readonly Event[]): Frame[] {
  const built: Frame[] = [];
  for (const event of events) {
    if (event.kind === 'frame') {
      built.push({ toggles: [], pickers: [], radios: [], rows: [], inputs: [] });
    } else {
      const frame = built.at(-1);
      if (frame) {
        append(frame, event);
      }
    }
  }
  return built;
}

function append(frame: Frame, event: Exclude<Event, { kind: 'frame' }>): void {
  if (event.kind === 'toggle') {
    frame.toggles.push(event.value);
  } else if (event.kind === 'picker') {
    frame.pickers.push(event.value);
  } else if (event.kind === 'radio') {
    frame.radios.push({ label: event.label, checked: event.checked });
  } else if (event.kind === 'row') {
    frame.rows.push(event.subtitle);
  } else {
    frame.inputs.push(event.defaultValue);
  }
}

const CASES: { name: string; Screen: ComponentType<{ scope: string }>; settled: Frame }[] = [
  {
    name: 'AnalysisSettingsScreen',
    Screen: AnalysisSettingsScreen,
    settled: {
      toggles: [],
      pickers: [],
      radios: [
        { label: i18n.t('securityAgent.analysisMode.auto'), checked: false },
        { label: i18n.t('securityAgent.analysisMode.shallow'), checked: false },
        { label: i18n.t('securityAgent.analysisMode.deep'), checked: true },
      ],
      rows: ['vendor/triage', 'vendor/analysis', 'vendor/remediation'],
      inputs: [],
    },
  },
  {
    name: 'AutomationSettingsScreen',
    Screen: AutomationSettingsScreen,
    settled: {
      toggles: [true, true, true, true, true, true],
      pickers: ['high', 'high', 'high'],
      radios: [],
      rows: [],
      inputs: [],
    },
  },
  {
    name: 'NotificationSettingsScreen',
    Screen: NotificationSettingsScreen,
    settled: {
      toggles: [true, true],
      pickers: ['high', 'high'],
      radios: [],
      rows: [],
      inputs: ['7'],
    },
  },
  {
    name: 'SlaSettingsScreen',
    Screen: SlaSettingsScreen,
    settled: {
      toggles: [true],
      pickers: [],
      radios: [],
      rows: [],
      inputs: ['3', '7', '14', '30'],
    },
  },
];

const mounts: TestRenderer.ReactTestRenderer[] = [];

function mount(Screen: ComponentType<{ scope: string }>) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Screen, { scope: 'personal' }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounts.push(renderer);
}

beforeEach(() => {
  config.data = null;
  config.isLoading = false;
  config.isError = false;
  record.events = [];
});

afterEach(() => {
  for (const renderer of mounts) {
    act(() => {
      renderer.unmount();
    });
  }
  mounts.length = 0;
});

describe.each(CASES)('$name body frames', ({ Screen, settled }) => {
  it('paints every body frame with the config draft already applied', () => {
    config.data = enabledConfig();
    mount(Screen);

    const built = frames(record.events);
    expect(built.length).toBeGreaterThan(0);
    // Every committed body frame already carries the config's draft: no frame
    // shows the default draft's collapsed sections before the config's arrive.
    for (const frame of built) {
      expect(frame).toEqual(settled);
    }
  });

  it('keeps the skeleton until the config arrives', () => {
    config.isLoading = true;
    mount(Screen);

    expect(frames(record.events)).toEqual([]);
  });
});
