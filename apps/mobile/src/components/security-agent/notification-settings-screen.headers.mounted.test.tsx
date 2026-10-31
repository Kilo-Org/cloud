import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { NotificationSettingsScreen } from './notification-settings-screen';

const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const capability = vi.hoisted(() => ({ canManage: true }));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
// The unsaved-changes guard is another screen's contract; only its shape is
// needed here.
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSettingsBackGuard: () => ({
    onBack: vi.fn(),
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
  useSecurityAgentSettingsRedirect: vi.fn(),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', foreground: '#14130F' }),
}));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
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
const toggleRows = vi.hoisted(() => ({ rows: [] as { title: string }[] }));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: (props: { title: string }) => {
    toggleRows.rows.push(props);
    return null;
  },
}));

function enabledConfig() {
  return {
    isEnabled: true,
    newFindingNotificationsEnabled: false,
    newFindingNotificationMinSeverity: 'low',
    slaNotificationsEnabled: false,
    slaNotificationMinSeverity: 'low',
    slaNotificationWarningDays: 7,
    slaEnabled: true,
  };
}

type R = TestRenderer.ReactTestRenderer;

function render(scope: string): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(NotificationSettingsScreen, { scope }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function texts(renderer: R): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

describe('NotificationSettingsScreen section headings', () => {
  beforeEach(() => {
    config.data = enabledConfig();
    config.isLoading = false;
    config.isError = false;
    capability.canManage = true;
    toggleRows.rows = [];
  });

  it('drops the section headings a personal scope already names on its rows', () => {
    const rendered = texts(render('personal'));

    // Each heading restated the only row below it, so the personal screen has
    // none; the rows keep their own titles.
    expect(rendered).not.toContain(i18n.t('securityAgent.notifications.newFindingSection'));
    expect(rendered).not.toContain(i18n.t('securityAgent.notifications.slaSection'));
    // The rows keep their own titles, which is what made the headings
    // redundant.
    expect(toggleRows.rows.slice(0, 2).map(row => row.title)).toEqual([
      i18n.t('securityAgent.notifications.newFindingPersonalTitle'),
      i18n.t('securityAgent.notifications.slaPersonalTitle'),
    ]);
  });

  it('keeps the section headings on an organization scope, whose rows share one title', () => {
    const rendered = texts(render('3f4a2c1e-0000-4000-8000-000000000000'));

    // Both rows are titled "Email owners" there, so the headings are what tells
    // the new-finding row from the SLA row.
    expect(rendered).toContain(i18n.t('securityAgent.notifications.newFindingSection'));
    expect(rendered).toContain(i18n.t('securityAgent.notifications.slaSection'));
  });
});
