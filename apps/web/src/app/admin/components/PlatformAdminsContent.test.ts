import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformAdminsContent as ContentComponent } from './PlatformAdminsContent';

const mockAdmins = [
  {
    id: 'admin-super',
    google_user_email: 'super@example.com',
    google_user_name: 'Super Admin',
    google_user_image_url: '',
    hosted_domain: 'kilocode.ai',
    blocked_reason: null,
    is_super_admin: true,
    can_view_sessions: true,
    can_manage_credits: false,
    can_export_api_request_logs: false,
  },
  {
    id: 'admin-plain',
    google_user_email: 'plain@example.com',
    google_user_name: 'Plain Admin',
    google_user_image_url: '',
    hosted_domain: 'kilocode.ai',
    blocked_reason: null,
    is_super_admin: false,
    can_view_sessions: false,
    can_manage_credits: false,
    can_export_api_request_logs: false,
  },
];

const mockRoster = {
  data: { admins: mockAdmins, currentUserId: 'viewer' },
  isLoading: false,
  error: null,
};
const mockMutate = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind?: string }) =>
    options.kind === 'roster'
      ? mockRoster
      : { data: [], isFetching: false, isError: false, error: null },
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ isPending: false, mutate: mockMutate }),
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      users: {
        listPlatformAdmins: {
          queryOptions: () => ({ kind: 'roster' }),
          queryKey: () => ['platform-admins'],
        },
        searchPlatformAdminCandidates: {
          queryOptions: () => ({ kind: 'candidates' }),
          queryKey: () => ['candidates'],
        },
        setPlatformAdminAccess: { mutationOptions: () => ({}) },
        setAdminPermissions: { mutationOptions: () => ({}) },
      },
      getPermissions: { queryKey: () => ['permissions'] },
    },
  }),
}));

jest.mock('@/app/admin/useAdminPermissions', () => ({
  useAdminPermissions: () => ({
    isPermissionResolved: true,
    isSuperadmin: true,
    canViewSessions: false,
    canManageCredits: false,
    canExportApiRequestLogs: false,
    isError: false,
  }),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}));

jest.mock('./UserAvatarLink', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    UserAvatarLink: ({ user }: { user: { google_user_email: string } }) =>
      ReactActual.createElement('span', null, user.google_user_email),
  };
});

jest.mock('./UserSearchInput', () => ({ UserSearchInput: () => null }));

jest.mock('@/components/ui/dialog', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  const PassThrough = ({ children }: { children?: React.ReactNode }) =>
    ReactActual.createElement(ReactActual.Fragment, null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
      open ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
    DialogContent: PassThrough,
    DialogHeader: PassThrough,
    DialogTitle: PassThrough,
    DialogDescription: PassThrough,
    DialogFooter: PassThrough,
    DialogClose: PassThrough,
  };
});

describe('PlatformAdminsContent permission dialog', () => {
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  let Content: typeof ContentComponent;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      configurable: true,
      get(this: HTMLInputElement) {
        return Reflect.get(this, '__checked') === true;
      },
      set(this: HTMLInputElement, value: boolean) {
        Reflect.set(this, '__checked', value);
      },
    });
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot } = await import('react-dom/client');
    ({ PlatformAdminsContent: Content } = await import('./PlatformAdminsContent'));
    root = createRoot(container);
    act(() => root.render(createElement(Content)));
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  function rowFor(email: string): HTMLTableRowElement {
    const rows = Array.from(container.querySelectorAll('tr')).filter(
      row => row.textContent?.includes(email) ?? false
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  function openPermissions(email: string) {
    const button = Array.from(rowFor(email).querySelectorAll('button')).find(
      candidate => candidate.textContent === 'Manage'
    );
    if (!button) throw new Error('Manage button missing');
    act(() => button.click());
  }

  function switchFor(id: string): HTMLButtonElement {
    const element = container.querySelector(`#${id}`);
    if (!element) throw new Error(`Switch missing: ${id}`);
    return element as HTMLButtonElement;
  }

  function saveButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      candidate => candidate.textContent === 'Save permissions'
    );
    if (!button) throw new Error('Save button missing');
    return button;
  }

  function acknowledgeSuperadmin() {
    const checkbox = container.querySelector<HTMLInputElement>('#permission-superadmin-confirm');
    if (!checkbox) throw new Error('Superadmin confirmation missing');
    act(() => {
      checkbox.checked = true;
      checkbox.click();
    });
  }

  it('renders Base admin first, disabled, and Superadmin last with the super user warning', () => {
    openPermissions('plain@example.com');

    const switchIds = Array.from(container.querySelectorAll('[role="switch"]')).map(
      element => element.id
    );
    expect(switchIds).toEqual([
      'permission-base-admin',
      'permission-session-viewer',
      'permission-credit-manager',
      'permission-api-request-log-exporter',
      'permission-superadmin',
    ]);

    const baseAdmin = switchFor('permission-base-admin');
    expect(baseAdmin.getAttribute('aria-checked')).toBe('true');
    expect(baseAdmin.hasAttribute('disabled')).toBe(true);
    expect(baseAdmin.getAttribute('aria-disabled')).toBe('true');

    expect(container.textContent).toContain('Base admin');
    expect(container.textContent).toContain('Required for every admin');
    expect(container.textContent).toContain('Super user');
    expect(container.textContent).toContain('SUPER USER credential');
  });

  it('requires the extra confirmation before saving a newly granted Superadmin', () => {
    openPermissions('plain@example.com');
    expect(saveButton().disabled).toBe(false);

    act(() => switchFor('permission-superadmin').click());
    expect(switchFor('permission-superadmin').getAttribute('aria-checked')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector('#permission-superadmin-confirm')).not.toBeNull();

    acknowledgeSuperadmin();
    expect(saveButton().disabled).toBe(false);

    act(() => saveButton().click());
    expect(mockMutate).toHaveBeenCalledWith({
      userId: 'admin-plain',
      permissions: { isSuperadmin: true },
    });
  });

  it('does not require the extra confirmation when Superadmin is turned off', () => {
    openPermissions('super@example.com');

    act(() => switchFor('permission-superadmin').click());
    expect(switchFor('permission-superadmin').getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('#permission-superadmin-confirm')).toBeNull();
    expect(saveButton().disabled).toBe(false);

    act(() => saveButton().click());
    expect(mockMutate).toHaveBeenCalledWith({
      userId: 'admin-super',
      permissions: { isSuperadmin: false },
    });
  });

  it('saves other permissions without the Superadmin confirmation', () => {
    openPermissions('plain@example.com');

    act(() => switchFor('permission-session-viewer').click());
    expect(saveButton().disabled).toBe(false);

    act(() => saveButton().click());
    expect(mockMutate).toHaveBeenCalledWith({
      userId: 'admin-plain',
      permissions: { canViewSessions: true },
    });
  });
});
