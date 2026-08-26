/** @jest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useEffect } from 'react';

import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { TRPCProvider } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import {
  MemberManagementDrawerStackProvider,
  useMemberManagementDrawerStack,
} from './MemberManagementDrawerStack';

// The real member-management UI (`OrganizationAdminMembers`) has its own
// heavy tRPC/session dependencies unrelated to this test's concern. Replace
// it with a probe that reports what the *real* OrganizationContext resolves
// to, so we can prove the drawer scopes context per child org rather than
// inheriting whatever the caller's outer context resolved to.
jest.mock('@/components/organizations/OrganizationMembersCard', () => ({
  OrganizationAdminMembers: ({ organizationId }: { organizationId: string }) => {
    const role = useUserOrganizationRole();
    const isKiloAdmin = useIsKiloAdmin();
    return (
      <div
        data-testid="member-management-probe"
        data-organization-id={organizationId}
        data-role={role}
        data-kilo-admin={String(isKiloAdmin)}
      />
    );
  },
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { email: 'viewer@example.com' }, isAdmin: false },
    status: 'authenticated',
  }),
}));

// The wizards have their own heavy dependencies (mutation hooks, multi-step
// state) covered by their own tests; here we only need to prove the
// discriminated-union `renderContent` dispatches to the right one with the
// right props.
jest.mock('./wizards/AddPeopleWizard', () => ({
  AddPeopleWizard: ({ seededIdentityKeys }: { seededIdentityKeys: string[] }) => (
    <div data-testid="add-people-wizard-probe" data-seeded={seededIdentityKeys.join(',')} />
  ),
}));
jest.mock('./wizards/RemovePeopleWizard', () => ({
  RemovePeopleWizard: ({ seededIdentityKeys }: { seededIdentityKeys: string[] }) => (
    <div data-testid="remove-people-wizard-probe" data-seeded={seededIdentityKeys.join(',')} />
  ),
}));

// The parent organization's viewer is an owner; the child organization's
// viewer is a plain member. If context ever leaked from the outer provider,
// the probe would incorrectly report "owner" for the child org.
jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: (organizationId: string) => ({
    data: {
      members: [
        {
          status: 'active',
          email: 'viewer@example.com',
          role: organizationId === 'parent-org' ? 'owner' : 'member',
        },
      ],
    },
  }),
}));

const EMPTY_PEOPLE_DATA = {
  children: [],
  people: [],
  pageInfo: { page: 1, pageSize: 25, total: 0, pageCount: 0 },
};

/** Opens the drawer for `child-org` as soon as it mounts. */
function OpenDrawerOnMount() {
  const drawer = useMemberManagementDrawerStack();
  useEffect(() => {
    drawer.open({
      type: 'manage-members',
      childOrganizationId: 'child-org',
      childOrganizationName: 'Child Org',
    });
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderWithProviders(children: React.ReactNode, queryClient = new QueryClient()) {
  const trpcClient = createTRPCClient<RootRouter>({
    links: [httpLink({ url: 'http://localhost/api/trpc' })],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}

describe('MemberManagementDrawerStack context scoping', () => {
  it('resolves the child organization role inside the drawer, not the outer parent-scoped role', async () => {
    renderWithProviders(
      <RoleTestingProvider>
        <OrganizationAdminContextProvider organizationId="parent-org">
          <MemberManagementDrawerStackProvider
            parentOrganizationId="parent-org"
            people={EMPTY_PEOPLE_DATA}
          >
            <OpenDrawerOnMount />
          </MemberManagementDrawerStackProvider>
        </OrganizationAdminContextProvider>
      </RoleTestingProvider>
    );

    const probe = await screen.findByTestId('member-management-probe');
    expect(probe.dataset.organizationId).toBe('child-org');
    expect(probe.dataset.role).toBe('member');
    expect(probe.dataset.role).not.toBe('owner');
  });

  it('renders nothing for the member-management UI while closed', () => {
    renderWithProviders(
      <RoleTestingProvider>
        <OrganizationAdminContextProvider organizationId="parent-org">
          <MemberManagementDrawerStackProvider
            parentOrganizationId="parent-org"
            people={EMPTY_PEOPLE_DATA}
          >
            <div />
          </MemberManagementDrawerStackProvider>
        </OrganizationAdminContextProvider>
      </RoleTestingProvider>
    );

    expect(screen.queryByTestId('member-management-probe')).toBeNull();
  });
});

describe('MemberManagementDrawerStack close invalidation', () => {
  it("invalidates the parent's people query once the stack empties", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    function Harness() {
      const drawer = useMemberManagementDrawerStack();
      return (
        <>
          <button
            onClick={() =>
              drawer.open({
                type: 'manage-members',
                childOrganizationId: 'child-org',
                childOrganizationName: 'Child Org',
              })
            }
          >
            open
          </button>
          <button onClick={() => drawer.closeAll()}>close</button>
        </>
      );
    }

    renderWithProviders(
      <RoleTestingProvider>
        <MemberManagementDrawerStackProvider
          parentOrganizationId="parent-org"
          people={EMPTY_PEOPLE_DATA}
        >
          <Harness />
        </MemberManagementDrawerStackProvider>
      </RoleTestingProvider>,
      queryClient
    );

    fireEvent.click(screen.getByText('open'));
    await screen.findByTestId('member-management-probe');

    invalidateSpy.mockClear();
    fireEvent.click(screen.getByText('close'));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [
          ['organizations', 'subOrganizations', 'people'],
          { input: { organizationId: 'parent-org' }, type: 'query' },
        ],
      });
    });
  });

  it('does not invalidate on initial mount (only on a >0 -> 0 transition)', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderWithProviders(
      <RoleTestingProvider>
        <MemberManagementDrawerStackProvider
          parentOrganizationId="parent-org"
          people={EMPTY_PEOPLE_DATA}
        >
          <div />
        </MemberManagementDrawerStackProvider>
      </RoleTestingProvider>,
      queryClient
    );

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('MemberManagementDrawerStack entry dispatch', () => {
  function Harness() {
    const drawer = useMemberManagementDrawerStack();
    return (
      <>
        <button
          onClick={() =>
            drawer.open({
              type: 'manage-members',
              childOrganizationId: 'child-org',
              childOrganizationName: 'Child Org',
            })
          }
        >
          open manage-members
        </button>
        <button
          onClick={() => drawer.open({ type: 'add-people', seededIdentityKeys: ['id-1', 'id-2'] })}
        >
          open add-people
        </button>
        <button
          onClick={() => drawer.open({ type: 'remove-people', seededIdentityKeys: ['id-3'] })}
        >
          open remove-people
        </button>
      </>
    );
  }

  function renderHarness() {
    renderWithProviders(
      <RoleTestingProvider>
        <MemberManagementDrawerStackProvider
          parentOrganizationId="parent-org"
          people={EMPTY_PEOPLE_DATA}
        >
          <Harness />
        </MemberManagementDrawerStackProvider>
      </RoleTestingProvider>
    );
  }

  it('renders the manage-members panel for a manage-members entry', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('open manage-members'));
    await screen.findByTestId('member-management-probe');
    expect(screen.queryByTestId('add-people-wizard-probe')).toBeNull();
    expect(screen.queryByTestId('remove-people-wizard-probe')).toBeNull();
  });

  it('renders the add-people wizard with its seeded selection for an add-people entry', () => {
    renderHarness();
    fireEvent.click(screen.getByText('open add-people'));
    const probe = screen.getByTestId('add-people-wizard-probe');
    expect(probe.dataset.seeded).toBe('id-1,id-2');
    expect(screen.queryByTestId('member-management-probe')).toBeNull();
  });

  it('renders the remove-people wizard with its seeded selection for a remove-people entry', () => {
    renderHarness();
    fireEvent.click(screen.getByText('open remove-people'));
    const probe = screen.getByTestId('remove-people-wizard-probe');
    expect(probe.dataset.seeded).toBe('id-3');
    expect(screen.queryByTestId('add-people-wizard-probe')).toBeNull();
  });
});
