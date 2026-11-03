// A field's announced name is the text the reader sees above it. The SLA
// lead-time field in the notification settings and the dismissal comment field
// once took their name from a second catalog key whose wording had drifted from
// the visible label in the same catalog (Hindi said "दें" on screen and "भेजें"
// in the name), so a screen reader announced one sentence as static text and a
// different one as the field's name. These suites pin the two strings together
// in the languages that drifted.

import { createElement, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';

import { DismissFindingScreen } from './dismiss-finding-screen';
import { NotificationSettingsScreen } from './notification-settings-screen';

vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000000' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  Switch: 'Switch',
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
  Alert: { alert: vi.fn() },
  I18nManager: { isRTL: false },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useNavigation: () => ({ dispatch: vi.fn(), goBack: vi.fn() }),
  useFocusEffect: (effect: () => void) => {
    useEffect(effect, [effect]);
  },
  usePreventRemove: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ ShieldOff: 'ShieldOff', Check: 'Check' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000',
    primaryForeground: '#fff',
    primary: '#00f',
  }),
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useSecurityFinding: () => ({
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    data: {
      status: 'open',
      title: 'ReDoS in payments SDK',
      repo_full_name: 'acme/payments-sdk',
      package_name: 'payments-sdk',
      package_ecosystem: 'npm',
    },
    refetch: vi.fn(),
  }),
  useDismissSecurityFinding: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissDraft: () => ({
    draft: null,
    hydrated: true,
    persist: vi.fn(),
    clear: vi.fn(),
  }),
  securityDismissFailureCopy: () => null,
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({
    canManage: true,
    status: 'allowed',
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useSecurityAgentConfig: () => ({
    data: {
      isEnabled: true,
      newFindingNotificationsEnabled: true,
      newFindingNotificationMinSeverity: 'high',
      slaNotificationsEnabled: true,
      slaNotificationMinSeverity: 'medium',
      slaNotificationWarningDays: 7,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useSaveSecurityAgentConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-dismiss-on-navigate', () => ({ useDismissOnNavigate: vi.fn() }));
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
  DestructiveConfirmDialog: () => null,
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: (props: { children?: unknown }) => props.children ?? null,
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
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/security-agent/settings-recovery-status', () => ({
  SettingsRecoveryStatus: 'SettingsRecoveryStatus',
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: () => null,
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children ?? null,
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  void i18n.changeLanguage('en');
});

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The one Text node rendering `copy`, i.e. the label the reader sees. */
function visibleLabel(
  mounted: TestRenderer.ReactTestRenderer,
  copy: string
): TestRenderer.ReactTestInstance {
  const match = mounted.root.findAllByType('Text').find(node => node.props.children === copy);
  if (!match) {
    throw new Error(`no Text node renders ${copy}`);
  }
  return match;
}

describe.each([
  ['English', 'en'],
  ['Hindi', 'hi'],
] as const)('notification settings field names in %s', (_name, language) => {
  it('announces the SLA lead-time field with the label the screen shows', async () => {
    await i18n.changeLanguage(language);
    const mounted = render(createElement(NotificationSettingsScreen, { scope: 'personal' }));
    const copy = i18n.t('securityAgent.notifications.slaLeadTimeLabel');

    // The label is what the reader sees; the field's name must be that string,
    // not a second key that can drift from it.
    expect(visibleLabel(mounted, copy)).toBeDefined();
    expect(mounted.root.findByType('Input').props.accessibilityLabel).toBe(copy);
  });
});

describe('dismissal comment field name', () => {
  it('announces the comment field with the label the sheet shows', async () => {
    await i18n.changeLanguage('hi');
    const mounted = render(
      createElement(DismissFindingScreen, { scope: 'personal', findingId: 'finding-1' })
    );
    const copy = i18n.t('securityAgent.dismiss.commentLabel');

    expect(visibleLabel(mounted, copy)).toBeDefined();
    expect(mounted.root.findByType('TextInput').props.accessibilityLabel).toBe(copy);
  });
});
