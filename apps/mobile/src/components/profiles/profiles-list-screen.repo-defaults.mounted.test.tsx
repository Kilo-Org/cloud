import { createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import {
  findOne,
  groupChildren,
  groupTexts,
  profile,
  type ProfileSummary,
  REPO_DEFAULTS_HEADING,
  repoDefaultsHeading,
  repoDefaultsRow,
  rowByTitle,
  rowGroup,
} from '@/components/profiles/profiles-list-screen.test-helpers';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  personalProfiles: [] as ProfileSummary[],
  push: vi.fn(),
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => ({
    orgProfiles: [],
    personalProfiles: h.personalProfiles,
    effectiveDefaultId: null,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: h.organizationId, isLoaded: true }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getNewProfilePath: (stack: 'app' | 'profileTab') =>
    stack === 'app' ? '/app-stack/profiles/new' : '/(app)/(tabs)/(3_profile)/profiles/new',
  getProfileOverviewPath: (profileId: string) => `/profiles/${profileId}`,
  getRepoBindingsPath: (options: { organizationId?: string; stack?: string } = {}) =>
    `${options.stack === 'app' ? '/app-stack' : '/(app)/(tabs)/(3_profile)/profiles'}/repo-bindings${
      options.organizationId ? `?organizationId=${options.organizationId}` : ''
    }`,
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
  GitBranch: 'GitBranch',
  Plus: 'Plus',
  SlidersHorizontal: 'SlidersHorizontal',
  Star: 'Star',
  User: 'User',
}));

function mount(stack: 'app' | 'profileTab' = 'profileTab') {
  return renderWithProviders(createElement(ProfilesListScreen, { stack }));
}

describe('ProfilesListScreen repo defaults entry', () => {
  beforeEach(() => {
    h.organizationId = 'org-1';
    h.personalProfiles = [profile({ id: 'personal-1', name: 'Personal profile' })];
    h.push.mockReset();
  });

  it('opens the bindings screen of the stack its list is mounted in', async () => {
    const profileTab = await mount();
    const profileTabRow = repoDefaultsRow(profileTab.renderer.root);
    // The icon the bindings screen and its own rows carry.
    expect(profileTabRow.props.icon).toBe('GitBranch');
    act(() => {
      (profileTabRow.props as { onPress: () => void }).onPress();
    });
    expect(h.push).toHaveBeenLastCalledWith(
      '/(app)/(tabs)/(3_profile)/profiles/repo-bindings?organizationId=org-1'
    );
    profileTab.unmount();

    h.push.mockReset();
    const appStack = await mount('app');
    act(() => {
      (repoDefaultsRow(appStack.renderer.root).props as { onPress: () => void }).onPress();
    });
    expect(h.push).toHaveBeenLastCalledWith('/app-stack/repo-bindings?organizationId=org-1');
    appStack.unmount();
  });

  it('carries no organization in a personal context', async () => {
    h.organizationId = null;

    const { renderer, unmount } = await mount();

    act(() => {
      (repoDefaultsRow(renderer.root).props as { onPress: () => void }).onPress();
    });
    expect(h.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/profiles/repo-bindings');

    unmount();
  });

  it('heads the profile rows with its own group like the settings group', async () => {
    const { renderer, unmount } = await mount();

    // The profiles heading is a direct scroll child, exactly like the settings
    // group's heading: the two groups space evenly and one heading cannot end
    // up nested inside the other group's gap.
    const scroll = findOne(renderer.root, 'ScrollView');
    const scrollChildren = groupChildren(scroll);
    const profilesHeading = scrollChildren.find(
      node => typeof node.props.children === 'string' && node.props.children === 'Profiles'
    );
    // The list labels the rows it already shows, so the unheaded profile
    // section cannot read as a stray row beside the labeled settings group.
    expect(profilesHeading?.props.children).toBe('Profiles');
    const settingsGroup = rowGroup(renderer.root, repoDefaultsRow(renderer.root));
    // The heading is the settings group's sibling on the scroll, not a child
    // inside it, so the gap above REPOSITORIES stays the scroll's group gap.
    expect(settingsGroup.props.className).toBe(
      rowGroup(renderer.root, rowByTitle(renderer.root, 'Personal profile')).props.className
    );

    unmount();
  });

  it('announces the full destination from the shortened visible row', async () => {
    const { renderer, unmount } = await mount();

    // The visible label drops the repos context the section header supplies,
    // so the row's own name keeps naming the destinations it opens.
    expect(repoDefaultsRow(renderer.root).props.accessibilityLabel).toBe(
      'Default profiles for repos'
    );

    unmount();
  });

  it('heads the entry with a group of its own, styled and spaced like a profile group', async () => {
    const { renderer, unmount } = await mount();

    const heading = repoDefaultsHeading(renderer.root);
    expect(heading.props.children).toBe(REPO_DEFAULTS_HEADING);
    // One heading over one row: the settings entry is a group, not a fifth
    // row of the personal group above it.
    const settingsGroup = rowGroup(renderer.root, repoDefaultsRow(renderer.root));
    expect(groupChildren(settingsGroup)).toHaveLength(2);

    // The owner sections are the reference, so the two cannot drift apart.
    const ownerGroup = rowGroup(renderer.root, rowByTitle(renderer.root, 'Personal profile'));
    const ownerHeading = groupTexts(ownerGroup)[0];
    expect(ownerHeading?.props.children).toBe('Personal');
    expect(heading.props.className).toBe(ownerHeading?.props.className);
    // The headings share one element, so the spacing around both groups is
    // the container gap the screen sets, not per-group markup.
    expect(settingsGroup.props.className).toBe(ownerGroup.props.className);

    unmount();
  });
});
