import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import {
  profile,
  type ProfileSummary,
} from '@/components/profiles/profiles-list-screen.test-helpers';
import { type FocusEffects, pressBurst, pressRowOfTitle } from '@/test/focus-burst.test-helpers';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

/**
 * The tap-burst guard of the Profiles list. Every row opens a pushed child
 * screen, so the list regains focus when that child closes itself; the presses
 * that belong to the closing burst must not reach the row underneath.
 */

type ListResult = {
  orgProfiles: ProfileSummary[];
  personalProfiles: ProfileSummary[];
  effectiveDefaultId: string | null;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: () => void;
};

const routerPush = vi.hoisted(() => vi.fn());
const refetchFn = vi.hoisted(() => vi.fn());
// The router's focus effect, captured so the case can replay the focus a return
// from a pushed child screen produces. `now` pins the clock the guard reads.
const focus = vi.hoisted<FocusEffects>(() => ({ effects: [], now: 1_700_000_000_000 }));
const listState = vi.hoisted<ListResult>(() => ({
  orgProfiles: [],
  personalProfiles: [],
  effectiveDefaultId: null,
  isLoading: false,
  isError: false,
  isRefetching: false,
  refetch: () => {
    refetchFn();
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => listState,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: true }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useFocusEffect: (effect: () => void) => {
    focus.effects.push(effect);
  },
}));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getNewProfilePath: (stack: 'app' | 'profileTab') =>
    stack === 'app' ? '/app-stack/profiles/new' : '/(app)/(tabs)/(3_profile)/profiles/new',
  getProfileOverviewPath: (
    profileId: string,
    options: { organizationId?: string; stack?: string } = {}
  ) =>
    `${options.stack === 'app' ? '/app-stack' : ''}/profiles/${profileId}${
      options.organizationId ? `?org=${options.organizationId}` : ''
    }`,
  getRepoBindingsPath: (options: { organizationId?: string; stack?: string } = {}) =>
    `${options.stack === 'app' ? '/app-stack' : '/(app)/(tabs)/(3_profile)/profiles'}/repo-bindings${
      options.organizationId ? `?organizationId=${options.organizationId}` : ''
    }`,
}));
vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111111',
    primary: '#4F5A10',
    primaryForeground: '#FFFFFF',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: ({ headerRight }: { headerRight?: ReactNode }) => headerRight ?? null,
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text', EYEBROW_LATIN_DISPLAY: 'uppercase' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
  GitBranch: 'GitBranch',
  Plus: 'Plus',
  SlidersHorizontal: 'SlidersHorizontal',
  Star: 'Star',
  User: 'User',
}));

let mounted: RenderWithProvidersResult | undefined = undefined;
async function mount(): Promise<RenderWithProvidersResult> {
  mounted = await renderWithProviders(createElement(ProfilesListScreen, { stack: 'profileTab' }));
  return mounted;
}

beforeEach(() => {
  routerPush.mockReset();
  focus.effects.length = 0;
  focus.now = 1_700_000_000_000;
  Object.assign(listState, {
    orgProfiles: [],
    personalProfiles: [],
    effectiveDefaultId: null,
    isLoading: false,
    isError: false,
    isRefetching: false,
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('ProfilesListScreen row press burst', () => {
  it('drops the row press of the burst that closed a pushed child screen', async () => {
    listState.personalProfiles = [profile({ id: 'personal-1', name: 'Personal profile' })];
    vi.spyOn(Date, 'now').mockImplementation(() => focus.now);

    const { renderer } = await mount();
    const burst = pressBurst(
      focus,
      pressRowOfTitle(renderer.root, 'ConfigureRow', 'Personal profile')
    );

    // The router focuses a fresh screen once on mount, and that first focus
    // must not deaden the rows.
    await burst.mount();
    burst.press();
    expect(routerPush).toHaveBeenCalledExactlyOnceWith('/profiles/personal-1');
    routerPush.mockReset();

    // The child screen closes itself and the router focuses this one again.
    await burst.childClosed();
    burst.burst();
    expect(routerPush).not.toHaveBeenCalled();

    burst.afterWindow();
    expect(routerPush).toHaveBeenCalledExactlyOnceWith('/profiles/personal-1');
  });
});
