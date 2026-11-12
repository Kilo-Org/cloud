import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ChildOrganizationMembership,
  OrganizationMemberResponse,
  OrganizationRole,
  OrganizationWithMembersResponse,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import { OrganizationContextProvider } from './OrganizationContext';
import type { OrganizationAdminMembers as OrganizationAdminMembersComponent } from './OrganizationMembersCard';

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({ data: mockOrganization, isLoading: false }),
  useSetChildMemberships: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteOrganizationInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRemoveMember: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: {
      groups: { list: { queryOptions: () => ({}) } },
      members: { resendInvite: { mutationOptions: () => ({}) } },
    },
  }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'viewer', email: 'viewer@example.com' } } }),
}));

jest.mock('@/lib/organizations/use-organization-read-only', () => ({
  useOrganizationReadOnly: () => false,
}));

jest.mock('../../app/admin/components/OrganizationAdmin/AddMemberDialog', () => ({
  AddMemberDialog: () => null,
}));
jest.mock('./members/InviteMemberDialog', () => ({ InviteMemberDialog: () => null }));
jest.mock('./members/MemberRoleDropdown', () => ({ MemberRoleDropdown: () => null }));
jest.mock('./members/EditDailyUsageLimitUsdDialog', () => ({
  EditDailyUsageLimitUsdDialog: () => null,
}));

jest.mock('@/components/ui/popover', () => {
  const react = jest.requireActual<typeof React>('react');
  const context = react.createContext<{
    open: boolean;
    setOpen: (open: boolean) => void;
  } | null>(null);

  function Popover({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = react.useState(false);
    return react.createElement(context.Provider, { value: { open, setOpen } }, children);
  }

  function PopoverTrigger({
    children,
  }: {
    children: React.ReactElement<{ onClick?: () => void }>;
  }) {
    const state = react.useContext(context);
    if (!state) throw new Error('Popover context missing');
    return react.cloneElement(children, { onClick: () => state.setOpen(!state.open) });
  }

  function PopoverContent({ children }: { children: React.ReactNode }) {
    const state = react.useContext(context);
    return state?.open ? react.createElement('div', null, children) : null;
  }

  return { Popover, PopoverTrigger, PopoverContent };
});

const mockMemberships = [
  { id: 'owner-team', name: 'Owner team', role: 'owner' },
  { id: 'admin-team', name: 'Admin team', role: 'admin' },
  { id: 'billing-team', name: 'Billing team', role: 'billing_manager' },
  { id: 'member-team', name: 'Member team', role: 'member' },
] satisfies ChildOrganizationMembership[];

const mockMember = {
  id: 'member',
  name: 'Parent member',
  email: 'member@example.com',
  role: 'member',
  status: 'active',
  inviteDate: null,
  dailyUsageLimitUsd: null,
  currentDailyUsageUsd: null,
  childOrganizationMemberships: mockMemberships,
} satisfies OrganizationMemberResponse;

const mockOrganization = {
  id: 'parent',
  name: 'Parent team',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  microdollars_used: 0,
  total_microdollars_acquired: 0,
  next_credit_expiration_at: null,
  stripe_customer_id: null,
  auto_top_up_enabled: false,
  settings: {},
  seat_count: 0,
  require_seats: false,
  created_by_kilo_user_id: null,
  deleted_at: null,
  sso_domain: null,
  parent_organization_id: null,
  plan: 'teams',
  free_trial_end_at: null,
  company_domain: null,
  callerRole: 'owner',
  members: [mockMember],
  childOrganizations: [
    ...mockMemberships.map(({ id, name }) => ({ id, name })),
    { id: 'unassigned-team', name: 'Unassigned team' },
  ],
  effectiveSsoPolicy: { required: false, source: null, domain: null, configurationError: false },
} satisfies OrganizationWithMembersResponse;

type LinkedomModule = {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

const { parseHTML } = createRequire(__filename)('linkedom') as LinkedomModule;
const previousReact = Reflect.get(globalThis, 'React');
let OrganizationAdminMembers: typeof OrganizationAdminMembersComponent;

beforeAll(async () => {
  Object.assign(globalThis, { React });
  ({ OrganizationAdminMembers } = await import('./OrganizationMembersCard'));
});
afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});

function card(viewerRole: OrganizationRole) {
  return createElement(
    OrganizationContextProvider,
    { value: { userRole: viewerRole } },
    createElement(OrganizationAdminMembers, { organizationId: mockOrganization.id })
  );
}

function installDom() {
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const values = {
    window,
    self: window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map(
    name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return {
    container,
    cleanup: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe('OrganizationMembersCard child team roles', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  it.each([
    { viewerRole: 'owner', tag: 'A' },
    { viewerRole: 'member', tag: 'SPAN' },
  ] as const)('shows correct child role badges for a $viewerRole viewer', ({ viewerRole, tag }) => {
    const html = renderToStaticMarkup(card(viewerRole));
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const badges = Array.from(document.querySelectorAll('[data-slot="badge"]'));

    expect(badges.map(badge => badge.textContent)).toEqual([
      'Owner team · Owner',
      'Admin team · Admin',
      'Billing team · Billing',
      'Member team',
    ]);
    expect(badges.map(badge => badge.tagName)).toEqual([tag, tag, tag, tag]);
    if (viewerRole === 'owner') {
      expect(badges.map(badge => badge.getAttribute('href'))).toEqual(
        mockMemberships.map(child => `/organizations/${child.id}`)
      );
    }
  });

  it('shows the correct locked role details while leaving member assignments editable', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    act(() => root?.render(card('owner')));

    const editButton = dom.container.querySelector<HTMLButtonElement>(
      'button[title="Edit member"]'
    );
    if (!editButton) throw new Error('Edit member button missing');
    act(() => {
      editButton.dispatchEvent(new Event('click', { bubbles: true }));
    });

    const childTeamsButton = Array.from(dom.container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Child teams'
    );
    if (!childTeamsButton) throw new Error('Child teams button missing');
    act(() => {
      childTeamsButton.dispatchEvent(new Event('click', { bubbles: true }));
    });

    const rows = Array.from(dom.container.querySelectorAll('label'));
    const expectedRows = [
      { name: 'Owner team', detail: 'Owner in child team', checked: true, disabled: true },
      { name: 'Admin team', detail: 'Admin in child team', checked: true, disabled: true },
      {
        name: 'Billing team',
        detail: 'Billing manager in child team',
        checked: true,
        disabled: true,
      },
      { name: 'Member team', detail: '', checked: true, disabled: false },
      { name: 'Unassigned team', detail: '', checked: false, disabled: false },
    ];

    expect(rows).toHaveLength(expectedRows.length);
    for (const expected of expectedRows) {
      const row = rows.find(label => label.textContent?.startsWith(expected.name));
      if (!row) throw new Error(`Child team row missing: ${expected.name}`);
      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!checkbox) throw new Error(`Child team checkbox missing: ${expected.name}`);
      expect(row.textContent).toBe(`${expected.name}${expected.detail}`);
      expect(checkbox.checked).toBe(expected.checked);
      expect(checkbox.disabled).toBe(expected.disabled);
    }
  });
});
