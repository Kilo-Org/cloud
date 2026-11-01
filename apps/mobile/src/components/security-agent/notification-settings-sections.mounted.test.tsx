// The personal notification settings screen titles each of its two switches
// after the notification it turns on ("Email me about new findings", "Email me
// about SLA warnings"), so a section heading above a single switch only restates
// it. The organization screen titles both switches "Email organization owners",
// so a heading is the only thing that tells the two of them apart.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

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
  usePreventRemove: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000',
    primaryForeground: '#fff',
    primary: '#00f',
  }),
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
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: () => null,
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

const PERSONAL_SCOPE = 'personal';
const ORGANIZATION_SCOPE = '00000000-0000-4000-8000-000000000001';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});

function mount(scope: string): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(createElement(NotificationSettingsScreen, { scope }));
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('personal scope', () => {
  it('titles each switch after its notification and shows no section heading', () => {
    const copy = mount(PERSONAL_SCOPE)
      .root.findAllByType('Text')
      .map(node => node.props.children);

    expect(copy).toContain(i18n.t('securityAgent.notifications.newFindingPersonalTitle'));
    expect(copy).toContain(i18n.t('securityAgent.notifications.slaPersonalTitle'));
    expect(copy).not.toContain(i18n.t('securityAgent.notifications.newFindingSection'));
    expect(copy).not.toContain(i18n.t('securityAgent.notifications.slaSection'));
  });

  it('separates the two switch groups by a break wider than the steps inside one', () => {
    const screen = mount(PERSONAL_SCOPE);

    expect(screen.root.findByType('TabScreenScrollView').props.contentContainerClassName).toBe(
      'px-6 pt-4 gap-7'
    );
  });
});

describe('organization scope', () => {
  it('heads each switch with its notification section, because both read the same recipient', () => {
    const names = mount(ORGANIZATION_SCOPE)
      .root.findAllByType('Switch')
      .map(node => node.props.accessibilityLabel);

    expect(names).toHaveLength(2);
    expect(names[0]).toContain(i18n.t('securityAgent.notifications.newFindingSection'));
    expect(names[1]).toContain(i18n.t('securityAgent.notifications.slaSection'));
    expect(names[1]).not.toContain(i18n.t('securityAgent.notifications.newFindingSection'));
  });

  it('keeps the standard group gap, next to its headings', () => {
    const screen = mount(ORGANIZATION_SCOPE);

    expect(screen.root.findByType('TabScreenScrollView').props.contentContainerClassName).toBe(
      'px-6 pt-4 gap-6'
    );
  });
});
