/* eslint-disable max-lines -- the switch is proven against the real account provider and both Stacks that push a profile detail, which needs one provider-mock surface for the file. */
import { createElement, Fragment, type ReactElement } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppStackProfileOverviewRoute from '@/app/(app)/profile-management/[profileId]';
import AppStackRepoBindingsRoute from '@/app/(app)/profile-management/repo-bindings';
import ProfileOverviewRoute from '@/app/(app)/(tabs)/(3_profile)/profiles/[profileId]';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

/**
 * A profile screen opened under one account must not survive a switch to
 * another, and must survive being opened for a scope the account never showed
 * (an agent session's own organization, or the composer's explicit scope). The
 * route carries its organization as a param and the account lives in the
 * organization provider, so these tests mount the real provider, switch the
 * account the way the account chip does (`setOrganizationId`), and assert what
 * the route does.
 */

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ORG_C = 'org-c';
const PROFILE_A = 'profile-a';

type RouteParams = { profileId?: string; organizationId?: string };

const params = vi.hoisted((): { value: RouteParams } => ({ value: {} }));
const router = vi.hoisted(() => ({
  dismissTo: vi.fn<(href: unknown) => void>(),
  back: vi.fn<() => void>(),
  push: vi.fn<(href: unknown) => void>(),
  replace: vi.fn<(href: unknown) => void>(),
}));
const stack = vi.hoisted((): { routes: { name: string }[]; index: number } => ({
  routes: [],
  index: 0,
}));
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const list = vi.hoisted(() => vi.fn());
const account = vi.hoisted((): { switchTo: (id: string | null) => void } => ({
  /** The provider's own switch, captured from a probe inside the provider. */
  switchTo: () => undefined,
}));

const navigation = vi.hoisted(() => ({
  getState: () => ({ index: stack.index, routes: stack.routes }),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.value,
  useRouter: () => router,
  useNavigation: () => navigation,
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ authEpoch: 0, token: 'token' }),
}));
vi.mock('@/lib/auth/logout-cleanup', () => ({
  unregisterActivityTokensAndTombstone: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: list }) },
    },
  }),
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/profiles/profile-overview-screen', () => ({
  ProfileOverviewScreen: 'ProfileOverviewScreen',
}));
vi.mock('@/components/profiles/repo-bindings-screen', () => ({
  RepoBindingsScreen: 'RepoBindingsScreen',
}));

function AccountSwitchProbe() {
  account.switchTo = useOrganization().setOrganizationId;
  return null;
}

const mounted: RenderWithProvidersResult[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  params.value = { profileId: PROFILE_A, organizationId: ORG_A };
  stack.routes = [{ name: 'profiles/index' }, { name: 'profiles/[profileId]/index' }];
  stack.index = 1;
  storage.read.mockReset().mockResolvedValue(ORG_A);
  storage.write.mockReset().mockResolvedValue(undefined);
  storage.remove.mockReset().mockResolvedValue(undefined);
  list.mockReset().mockResolvedValue([
    { organizationId: ORG_A, organizationName: 'Consultoria', role: 'owner' },
    { organizationId: ORG_B, organizationName: 'Client Co', role: 'member' },
    { organizationId: ORG_C, organizationName: 'Client Co Two', role: 'member' },
  ]);
  account.switchTo = () => undefined;
});

afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

function screensOnScreen(ui: RenderWithProvidersResult, screen: string): number {
  return ui.renderer.root.findAllByType(screen as never).length;
}

async function mountRoute(route: () => ReactElement | null, screen = 'ProfileOverviewScreen') {
  const ui = await renderWithProviders(
    createElement(Fragment, null, createElement(AccountSwitchProbe), createElement(route)),
    { wrapper: OrganizationProvider }
  );
  mounted.push(ui);
  await waitFor(() => screensOnScreen(ui, screen) > 0);
  return ui;
}

async function switchAccountTo(organizationId: string | null): Promise<void> {
  await act(() => {
    account.switchTo(organizationId);
  });
}

describe('a profile detail after an account switch', () => {
  it('leaves the previous account profile for the profiles list of the Profile tab', async () => {
    const ui = await mountRoute(ProfileOverviewRoute);
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(1);

    await switchAccountTo(ORG_B);

    expect(router.dismissTo).toHaveBeenCalledWith(getProfilesPath('profileTab'));
    expect(router.back).not.toHaveBeenCalled();
    // The previous account's profile is not on screen even for the frame the
    // dismissal takes, so its editor cannot be tapped.
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(0);
  });

  it('goes back when the root stack opened the detail with no list beneath it', async () => {
    stack.routes = [
      { name: 'agent-chat/[session-id]' },
      { name: 'profile-management/[profileId]/index' },
    ];
    const ui = await mountRoute(AppStackProfileOverviewRoute);
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(1);

    await switchAccountTo(ORG_B);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(0);
  });

  it('stays when the account did not change', async () => {
    const ui = await mountRoute(ProfileOverviewRoute);

    await switchAccountTo(ORG_A);

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(1);
  });

  it('keeps a personal profile open, which every account reads', async () => {
    params.value = { profileId: PROFILE_A };
    const ui = await mountRoute(ProfileOverviewRoute);

    await switchAccountTo(ORG_B);

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(1);
  });

  it('keeps a session profile editor open for the session organization the account never showed', async () => {
    // A session of another organization renders while the selection is this
    // account, and its profile chip opens that organization's profile.
    params.value = { profileId: PROFILE_A, organizationId: ORG_B };
    stack.routes = [
      { name: 'agent-chat/[session-id]' },
      { name: 'profile-management/[profileId]/index' },
    ];
    const ui = await mountRoute(AppStackProfileOverviewRoute);

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(1);
  });

  it('keeps repo defaults open for the composer scope while the account shows another', async () => {
    params.value = { organizationId: ORG_B };
    stack.routes = [{ name: 'agent-chat/new' }, { name: 'profile-management/repo-bindings' }];
    const ui = await mountRoute(AppStackRepoBindingsRoute, 'RepoBindingsScreen');

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'RepoBindingsScreen')).toBe(1);
  });

  it('leaves repo defaults once the account switches while they are open', async () => {
    params.value = { organizationId: ORG_A };
    stack.routes = [
      { name: 'profile-management/index' },
      { name: 'profile-management/repo-bindings' },
    ];
    const ui = await mountRoute(AppStackRepoBindingsRoute, 'RepoBindingsScreen');

    await switchAccountTo(ORG_C);

    expect(router.dismissTo).toHaveBeenCalledWith(getProfilesPath('app'));
    expect(screensOnScreen(ui, 'RepoBindingsScreen')).toBe(0);
  });

  it('reads the stored account before deciding, so a cold start never dismisses', async () => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReset().mockReturnValue(read.promise);
    const ui = await renderWithProviders(
      createElement(
        Fragment,
        null,
        createElement(AccountSwitchProbe),
        createElement(ProfileOverviewRoute)
      ),
      { wrapper: OrganizationProvider }
    );
    mounted.push(ui);

    expect(router.dismissTo).not.toHaveBeenCalled();
    await act(() => {
      read.resolve(ORG_A);
    });

    expect(storage.read).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'ProfileOverviewScreen')).toBe(1);
  });
});
