// The SLA settings load-failure state names the failed read in its own error
// title and leaves the description to the classified read-failure variant. A
// message here would repeat the same words above the variant's cause, which is
// the shape every Security Agent settings screen shared.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SlaSettingsScreen } from './sla-settings-screen';

const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  error: null as unknown,
  refetch: vi.fn(),
}));
const platformError = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useFocusEffect: () => undefined,
  usePreventRemove: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ Clock: 'Clock' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useMutedDisabledInk: () => '#fff',
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSecurityAgentSettingsRedirect: () => undefined,
  useSettingsBackGuard: () => ({
    onBack: vi.fn(),
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: 'SettingsSaveButton',
}));
vi.mock('@/components/security-agent/sla-day-row', () => ({
  SLA_ROWS: [],
  SlaDayRow: 'SlaDayRow',
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: (props: Record<string, unknown>) => {
    platformError.props = props;
    return null;
  },
}));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  config.data = null;
  config.isLoading = false;
  config.isError = false;
  config.isPending = false;
  config.fetchStatus = 'idle';
  config.error = null;
  config.refetch.mockReset();
  platformError.props = null;
});

describe('SlaSettingsScreen load failure copy', () => {
  it('titles the failure with the screen and leaves the description to the variant', () => {
    config.isError = true;
    config.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    act(() => {
      TestRenderer.create(createElement(SlaSettingsScreen, { scope: 'personal' }));
    });

    const error = platformError.props;
    if (!error) {
      throw new Error('failed first read did not render the failure screen');
    }
    expect(error.errorTitle).toBe(i18n.t('securityAgent.sla.couldNotLoad'));
    expect(error.message).toBeUndefined();
    expect(error.variant).toBe('server');
  });
});
