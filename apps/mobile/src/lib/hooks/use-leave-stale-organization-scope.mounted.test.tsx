/* eslint-disable max-lines -- the switch is proven against the real account provider and every guarded organization route, which needs one provider-mock surface for the file. */
import { createElement, Fragment, type ReactElement } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreditActivityRoute from '@/app/(app)/(tabs)/(3_profile)/organization/credit-activity';
import InviteMemberRoute from '@/app/(app)/(tabs)/(3_profile)/organization/invite-member';
import InvoicesRoute from '@/app/(app)/(tabs)/(3_profile)/organization/invoices';
import MembersRoute from '@/app/(app)/(tabs)/(3_profile)/organization/members';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

/**
 * An organization screen opened under one account must not survive a switch to
 * another: it re-scopes to the new account silently and, where that account has
 * no access (a plain member has no invoices), shows a permanent refusal instead
 * of the current account's hub. The account lives in the organization provider,
 * so these tests mount the real provider, switch the account the way the
 * account chip does (`setOrganizationId`), and assert what the route does.
 */

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ORG_C = 'org-c';

const params = vi.hoisted((): { value: Record<string, string> } => ({ value: {} }));
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
  addListener: vi.fn(() => () => undefined),
  reset: vi.fn(),
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
vi.mock('@/components/organization/invoices-screen', () => ({
  OrganizationInvoicesScreen: 'OrganizationInvoicesScreen',
}));
vi.mock('@/components/organization/members-screen', () => ({
  OrganizationMembersScreen: 'OrganizationMembersScreen',
}));
vi.mock('@/components/organization/invite-member-sheet', () => ({
  InviteMemberSheet: 'InviteMemberSheet',
}));
vi.mock('@/components/organization/credit-activity-screen', () => ({
  OrganizationCreditActivityScreen: 'OrganizationCreditActivityScreen',
}));

function AccountSwitchProbe() {
  account.switchTo = useOrganization().setOrganizationId;
  return null;
}

const mounted: RenderWithProvidersResult[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  params.value = {};
  stack.routes = [{ name: 'index' }, { name: 'invoices' }];
  stack.index = 1;
  storage.read.mockReset().mockResolvedValue(ORG_A);
  storage.write.mockReset().mockResolvedValue(undefined);
  storage.remove.mockReset().mockResolvedValue(undefined);
  list.mockReset().mockResolvedValue([
    { organizationId: ORG_A, organizationName: 'Consultoria', role: 'owner' },
    { organizationId: ORG_B, organizationName: 'Studio', role: 'member' },
    { organizationId: ORG_C, organizationName: 'Client Co', role: 'member' },
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

async function mountRoute(route: () => ReactElement | null, screen: string) {
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

describe('an organization screen after an account switch', () => {
  it('returns the previous account invoices to the current account hub', async () => {
    const ui = await mountRoute(InvoicesRoute, 'OrganizationInvoicesScreen');
    expect(screensOnScreen(ui, 'OrganizationInvoicesScreen')).toBe(1);

    await switchAccountTo(ORG_B);

    expect(router.dismissTo).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
    expect(router.back).not.toHaveBeenCalled();
    // The previous account's screen is off screen even for the frame the
    // dismissal takes, so it cannot be read or tapped.
    expect(screensOnScreen(ui, 'OrganizationInvoicesScreen')).toBe(0);
  });

  it('returns the members list to the current account hub', async () => {
    stack.routes = [{ name: 'index' }, { name: 'members' }];
    const ui = await mountRoute(MembersRoute, 'OrganizationMembersScreen');

    await switchAccountTo(ORG_B);

    expect(router.dismissTo).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
    expect(screensOnScreen(ui, 'OrganizationMembersScreen')).toBe(0);
  });

  it('closes a sheet the previous account opened', async () => {
    stack.routes = [{ name: 'index' }, { name: 'invite-member' }];
    const ui = await mountRoute(InviteMemberRoute, 'InviteMemberSheet');

    await switchAccountTo(ORG_B);

    expect(router.dismissTo).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
    expect(screensOnScreen(ui, 'InviteMemberSheet')).toBe(0);
  });

  it('stays when the account did not change', async () => {
    const ui = await mountRoute(InvoicesRoute, 'OrganizationInvoicesScreen');

    await switchAccountTo(ORG_A);

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'OrganizationInvoicesScreen')).toBe(1);
  });

  it('goes back when the hub is not beneath the stale screen', async () => {
    stack.routes = [{ name: 'profiles/index' }, { name: 'invoices' }];
    const ui = await mountRoute(InvoicesRoute, 'OrganizationInvoicesScreen');

    await switchAccountTo(ORG_C);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'OrganizationInvoicesScreen')).toBe(0);
  });

  it('pushes the hub when the stale screen is the only route of its stack', async () => {
    stack.routes = [{ name: 'invoices' }];
    stack.index = 0;
    const ui = await mountRoute(InvoicesRoute, 'OrganizationInvoicesScreen');

    await switchAccountTo(ORG_B);

    // Nothing to pop to and no hub beneath: the hub is pushed and the stale
    // screen retired after the transition, never rewritten in one commit.
    expect(router.push).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'OrganizationInvoicesScreen')).toBe(0);
  });

  it('keeps a credit activity link that names its own organization', async () => {
    // The linked screen selects the organization it names, so the change is its
    // own scope and not a switch away from the account it shows.
    params.value = { org: ORG_B };
    stack.routes = [{ name: 'index' }, { name: 'credit-activity' }];
    const ui = await mountRoute(CreditActivityRoute, 'OrganizationCreditActivityScreen');

    await switchAccountTo(ORG_C);

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screensOnScreen(ui, 'OrganizationCreditActivityScreen')).toBe(1);
  });

  it('leaves a credit activity opened without an organization on a switch', async () => {
    stack.routes = [{ name: 'index' }, { name: 'credit-activity' }];
    const ui = await mountRoute(CreditActivityRoute, 'OrganizationCreditActivityScreen');

    await switchAccountTo(ORG_B);

    expect(router.dismissTo).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
    expect(screensOnScreen(ui, 'OrganizationCreditActivityScreen')).toBe(0);
  });

  it('reads the stored account before deciding, so a cold start never dismisses', async () => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReset().mockReturnValue(read.promise);
    const ui = await renderWithProviders(
      createElement(
        Fragment,
        null,
        createElement(AccountSwitchProbe),
        createElement(InvoicesRoute)
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
    expect(screensOnScreen(ui, 'OrganizationInvoicesScreen')).toBe(1);
  });
});
