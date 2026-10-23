import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  orgProfiles: [] as { id: string; name: string; isDefault: boolean }[],
  personalProfiles: [] as { id: string; name: string; isDefault: boolean }[],
  push: vi.fn(),
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => ({
    orgProfiles: h.orgProfiles,
    personalProfiles: h.personalProfiles,
    effectiveDefaultId: null,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => false,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: true }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getNewProfilePath: () => '/profiles/new',
  getProfileOverviewPath: (profileId: string) => `/profiles/${profileId}`,
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#666666' }),
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: ({ headerRight }: { headerRight?: ReactNode }) => headerRight ?? null,
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
  Plus: 'Plus',
  SlidersHorizontal: 'SlidersHorizontal',
  Star: 'Star',
  User: 'User',
}));

describe('ProfilesListScreen read-only organization scope', () => {
  beforeEach(() => {
    h.orgProfiles = [];
    h.personalProfiles = [];
    h.push.mockReset();
  });

  it('renders without profile creation actions', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfilesListScreen, { stack: 'profileTab' })
    );

    const elements = renderer.root.findAll(node => typeof node.type === 'string');
    expect(elements.filter(node => String(node.type) === 'IconButton')).toHaveLength(0);
    expect(elements.find(node => String(node.type) === 'EmptyState')?.props.action).toBeNull();

    unmount();
  });
});
