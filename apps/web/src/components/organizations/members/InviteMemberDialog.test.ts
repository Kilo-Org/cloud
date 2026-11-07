import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type * as DialogModule from './InviteMemberDialog';

let InviteMemberDialog: typeof DialogModule.InviteMemberDialog;
let hasInviteSeatCapacity: typeof DialogModule.hasInviteSeatCapacity;
let inviteEmailErrorMessage: typeof DialogModule.inviteEmailErrorMessage;
let INVITE_SUCCESS_MESSAGE: typeof DialogModule.INVITE_SUCCESS_MESSAGE;
let organizationMemberInvitedCaptureProperties: typeof DialogModule.organizationMemberInvitedCaptureProperties;

const mutate = jest.fn();
let inputChange: ((event: { target: { value: string } }) => void) | undefined;

jest.mock('@/app/api/organizations/hooks', () => ({
  useInviteMember: () => ({ mutate, isPending: false }),
  useOrganizationSeatUsage: () => ({ data: { usedSeats: 0, totalSeats: 1 } }),
  useOrganizationWithMembers: () => ({
    data: {
      plan: 'teams',
      require_seats: true,
      effectiveSsoPolicy: { required: true, source: 'self', domain: 'example.com' },
    },
  }),
}));
jest.mock('@/components/organizations/OrganizationContext', () => ({
  useIsKiloAdmin: () => false,
  useUserOrganizationRole: () => 'owner',
}));
jest.mock('posthog-js/react', () => ({ usePostHog: () => undefined }));
jest.mock('../LockableContainer', () => ({
  LockableContainer: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/input', () => ({
  Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => {
    inputChange = onChange as typeof inputChange;
    return createElement('input', { ...props, onChange });
  },
}));
jest.mock('@/components/ui/dialog', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement('div', {}, children);
  return {
    Dialog: wrapper,
    DialogContent: wrapper,
    DialogDescription: wrapper,
    DialogFooter: wrapper,
    DialogHeader: wrapper,
    DialogTitle: wrapper,
  };
});
jest.mock('@/components/ui/dropdown-menu', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement('div', {}, children);
  return {
    DropdownMenu: wrapper,
    DropdownMenuContent: wrapper,
    DropdownMenuItem: wrapper,
    DropdownMenuTrigger: wrapper,
  };
});

beforeAll(async () => {
  ({
    InviteMemberDialog,
    hasInviteSeatCapacity,
    inviteEmailErrorMessage,
    INVITE_SUCCESS_MESSAGE,
    organizationMemberInvitedCaptureProperties,
  } = await import('./InviteMemberDialog'));
});

describe('InviteMemberDialog with required SSO', () => {
  let root: Root | undefined;
  let previous: Record<string, unknown>;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    Object.assign(globalThis, previous);
    mutate.mockClear();
    inputChange = undefined;
  });

  function mountDialog() {
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const values = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    previous = Object.fromEntries(Object.keys(values).map(key => [key, globals[key]]));
    Object.assign(globals, values);
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root');
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(InviteMemberDialog, {
          open: true,
          onOpenChange: jest.fn(),
          organizationId: 'org-1',
          onMemberInvited: jest.fn(),
        })
      )
    );
    return container;
  }

  test('allows an owner to invite an SSO domain member', () => {
    const container = mountDialog();
    act(() => inputChange?.({ target: { value: 'person@example.com' } }));
    const emailInput = container.querySelector('input');
    const inviteButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Send Invitation')
    );
    expect(emailInput?.getAttribute('aria-invalid')).toBe('false');
    expect(inviteButton?.disabled).toBe(false);
    act(() => inviteButton?.click());
    expect(mutate).toHaveBeenCalledWith(
      { organizationId: 'org-1', email: 'person@example.com', role: 'member' },
      expect.any(Object)
    );
  });

  test('refuses an over-length address in the field and never sends it', () => {
    const container = mountDialog();
    // One character past the 254-character maximum, in the shape a mail system
    // could otherwise route.
    const oneMore = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    act(() => inputChange?.({ target: { value: oneMore } }));

    expect(container.querySelector('input')?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Email address must be 254 characters or fewer');
    const inviteButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Send Invitation')
    );
    expect(inviteButton?.disabled).toBe(true);
    act(() => inviteButton?.click());
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('inviteEmailErrorMessage', () => {
  test('accepts the 254-character boundary and names the length past it', () => {
    const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    const oneMore = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(longest).toHaveLength(254);
    expect(oneMore).toHaveLength(255);
    expect(inviteEmailErrorMessage(longest)).toBeNull();
    expect(inviteEmailErrorMessage(oneMore)).toBe('Email address must be 254 characters or fewer');
  });

  test('keeps the invalid-address sentence for an address the syntax rule rejects', () => {
    expect(inviteEmailErrorMessage('not-an-email')).toBe('Please enter a valid email address');
    expect(inviteEmailErrorMessage('   ')).toBe('Please enter a valid email address');
  });
});

describe('hasInviteSeatCapacity', () => {
  test('allows Teams invitations when seat requirements are disabled', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: false,
        usedSeats: 1,
        totalSeats: 0,
      })
    ).toBe(true);
  });

  test('blocks Teams invitations when required seats are full', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: true,
        usedSeats: 1,
        totalSeats: 1,
      })
    ).toBe(false);
  });
});

describe('INVITE_SUCCESS_MESSAGE', () => {
  test('says the invite was created, not sent', () => {
    expect(INVITE_SUCCESS_MESSAGE).toBe('Invite created');
    expect(INVITE_SUCCESS_MESSAGE.toLowerCase()).not.toContain('sent');
  });
});

describe('organizationMemberInvitedCaptureProperties', () => {
  test('returns only the role', () => {
    expect(organizationMemberInvitedCaptureProperties('member')).toEqual({ role: 'member' });
    expect(Object.keys(organizationMemberInvitedCaptureProperties('admin'))).toEqual(['role']);
    expect(organizationMemberInvitedCaptureProperties('member')).not.toHaveProperty(
      'organizationId'
    );
    expect(organizationMemberInvitedCaptureProperties('member')).not.toHaveProperty('email');
  });

  test('the dialog source uses the helper and never the old capture argument list', () => {
    const source = readFileSync(path.resolve(__dirname, './InviteMemberDialog.tsx'), 'utf8');
    expect(source).toContain('organizationMemberInvitedCaptureProperties');
    expect(source).not.toContain('organizationId, email, role');
  });
});
