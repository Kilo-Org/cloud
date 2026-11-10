/* eslint-disable max-lines -- the invite sheet suites share one mock harness. */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { InviteMemberSheet } from './invite-member-sheet';

type Boundary = {
  organizationId: string | null;
  role: string;
  org: { organizationId: string } | null;
  isResolving: boolean;
};

const boundary = vi.hoisted((): Boundary => ({
  organizationId: 'org-1',
  role: 'owner',
  org: { organizationId: 'org-1' },
  isResolving: false,
}));
const invite = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  // An address with an outstanding invitation, as the procedure rejects it: the
  // sheet renders its own line for that rejection, not the server's sentence.
  error: { data: { code: 'CONFLICT', message: 'This email already has a pending invitation' } },
}));
// The route's focus effects: the sheet registers its form reset and its Back
// handler on every render, and the test re-runs them to present the sheet
// again. `useCallback` keeps each identity stable, so a render adds nothing.
const focus = vi.hoisted(() => ({ effects: [] as (() => void)[] }));
// The route's own dismissal: one call per leave, however many reasons arrive.
const popOnce = vi.hoisted(() => vi.fn());
// The Android Back listener the sheet registers on focus.
const backPress = vi.hoisted(() => ({ handler: undefined as (() => boolean) | undefined }));

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => {
    if (!focus.effects.includes(effect)) {
      focus.effects.push(effect);
    }
  },
}));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backPress.handler = handler;
      return { remove: () => undefined };
    },
  },
}));
vi.mock('@/lib/navigation/pop-once', () => ({ usePopOnce: () => popOnce }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/organization/member-row', () => ({ roleLabel: String }));
vi.mock('@/components/organization/invited-member-row-state', () => ({
  getInviteSuccessMessage: () => '',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
// The real clearance reads the tab bar and the keyboard, neither of which this
// suite models: the sheet still renders its body as the ScrollView host.
vi.mock('@/components/tab-screen', () => ({ SheetScrollView: 'ScrollView' }));
// The sheet's own dirty check: what Cancel and Back would ask about.
const guard = vi.hoisted(() => ({ isDirty: (): boolean => false, requestClose: vi.fn() }));
vi.mock('@/components/ui/use-sheet-dismiss-guard', () => ({
  useSheetDismissGuard: (options: { isDirty: () => boolean }) => {
    guard.isDirty = options.isDirty;
    return {
      requestClose: guard.requestClose,
      requestDismiss: () => true,
      dialog: null,
    };
  },
}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { success: vi.fn() } }));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  ORGANIZATION_MEMBER_INVITED_EVENT: 'invited',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundary,
  // canManageOrganizationBilling: an admin may invite, so it may open the sheet.
  isMoneyRole: (role: string) => role === 'owner' || role === 'admin' || role === 'billing_manager',
}));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({ invite }),
}));

beforeEach(() => {
  boundary.organizationId = 'org-1';
  boundary.org = { organizationId: 'org-1' };
  boundary.role = 'owner';
  boundary.isResolving = false;
  invite.isPending = false;
  invite.isError = false;
  invite.error = {
    data: { code: 'CONFLICT', message: 'This email already has a pending invitation' },
  };
  invite.mutate.mockClear();
  invite.reset.mockClear();
  popOnce.mockClear();
  guard.requestClose.mockClear();
  backPress.handler = undefined;
  focus.effects = [];
});

type FieldProps = {
  onBlur: (event: unknown) => void;
  onChangeText: (value: string) => void;
};
type HeaderProps = { doneDisabled?: boolean; disabled?: boolean; onDone: () => void };
type RoleProps = { onPress: () => void };

/** The props of the one host element of `type`: a second one means the screen changed shape. */
function hostProps(rendered: RenderWithProvidersResult, type: string): Record<string, unknown> {
  const matches = rendered.renderer.root.findAll(node => String(node.type) === type);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error(`missing ${type}`);
  }
  return match.props as Record<string, unknown>;
}

function fieldProps(rendered: RenderWithProvidersResult): FieldProps {
  return hostProps(rendered, 'Input') as FieldProps;
}

function headerProps(rendered: RenderWithProvidersResult): HeaderProps {
  return hostProps(rendered, 'SheetHeader') as HeaderProps;
}

/** The row at `index` of the sheet's role list, in the order the screen draws it. */
function roleRowProps(rendered: RenderWithProvidersResult, index: number): RoleProps {
  const rows = rendered.renderer.root.findAll(node => String(node.type) === 'Pressable');
  const row = rows[index];
  if (!row) {
    throw new Error(`missing role row ${index}`);
  }
  return row.props as RoleProps;
}

/** The field's inline error: the first AccessibleStatus is the one FormField renders. */
function errorMessage(rendered: RenderWithProvidersResult): unknown {
  const [fieldStatus] = rendered.renderer.root.findAll(
    node => String(node.type) === 'AccessibleStatus'
  );
  if (!fieldStatus) {
    throw new Error('missing AccessibleStatus');
  }
  return fieldStatus.props.message;
}

/** The invite mutation's inline error: the second AccessibleStatus on the screen. */
function inviteMessage(rendered: RenderWithProvidersResult): unknown {
  const statuses = rendered.renderer.root.findAll(node => String(node.type) === 'AccessibleStatus');
  return statuses[1]?.props.message as unknown;
}

/** Run every focus effect the mounted sheet registered: a re-presented sheet. */
function refocus() {
  act(() => {
    for (const effect of focus.effects) {
      effect();
    }
  });
}

/** Mount, then run the first focus — a fresh mount's state is already clean. */
async function openSheet(): Promise<RenderWithProvidersResult> {
  const rendered = await renderWithProviders(createElement(InviteMemberSheet));
  refocus();
  expect(invite.reset).not.toHaveBeenCalled();
  return rendered;
}

describe('InviteMemberSheet reopen', () => {
  it('clears the field error and derived state when the sheet is focused again', async () => {
    const rendered = await openSheet();

    act(() => {
      fieldProps(rendered).onBlur({});
    });
    expect(errorMessage(rendered)).toBeTruthy();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    expect(errorMessage(rendered)).toBeNull();
    expect(headerProps(rendered).doneDisabled).toBe(false);

    refocus();

    expect(errorMessage(rendered)).toBeNull();
    expect(headerProps(rendered).doneDisabled).toBe(true);
    expect(invite.reset).toHaveBeenCalledOnce();
    rendered.unmount();
  });

  it('validates the empty field again after the reset', async () => {
    const rendered = await openSheet();
    refocus();

    act(() => {
      fieldProps(rendered).onBlur({});
    });

    expect(errorMessage(rendered)).toBeTruthy();
    rendered.unmount();
  });

  it('returns the role to the default on the next open, so the form is not dirty', async () => {
    const rendered = await openSheet();
    expect(guard.isDirty()).toBe(false);

    act(() => {
      roleRowProps(rendered, 2).onPress();
    });
    expect(guard.isDirty()).toBe(true);

    refocus();

    expect(guard.isDirty()).toBe(false);
    rendered.unmount();
  });

  it('keeps an invite that is still running on the next open, without its error', async () => {
    const rendered = await openSheet();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      headerProps(rendered).onDone();
    });
    expect(invite.mutate).toHaveBeenCalledOnce();

    invite.isPending = true;
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    refocus();

    expect(invite.reset).not.toHaveBeenCalled();
    expect(headerProps(rendered).doneDisabled).toBe(true);

    // The earlier attempt fails after the reopen: its rejection belongs to the
    // previous form, not to the one on screen now, so neither the field nor the
    // form announces it. A schema rejection would land on the field, so an
    // address the field itself accepts is the case that can leak.
    invite.isPending = false;
    invite.isError = true;
    invite.error = { data: { code: 'BAD_REQUEST', message: 'Invalid email address' } };
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });

    expect(errorMessage(rendered)).toBeNull();
    expect(inviteMessage(rendered)).toBeNull();
    rendered.unmount();
  });

  it('shows the invite error of a submit made in this open', async () => {
    const rendered = await openSheet();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      headerProps(rendered).onDone();
    });
    invite.isError = true;
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });

    expect(inviteMessage(rendered)).toBe(i18n.t('organization.inviteMember.pendingInvitation'));
    rendered.unmount();
  });

  it('places a rejected address on the email field and drops it on the next open', async () => {
    const rendered = await openSheet();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      headerProps(rendered).onDone();
    });

    invite.isError = true;
    invite.error = { data: { code: 'BAD_REQUEST', message: 'Invalid email address' } };
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });

    expect(errorMessage(rendered)).toBe(i18n.t('organization.inviteMember.emailError'));

    refocus();

    expect(errorMessage(rendered)).toBeNull();
    rendered.unmount();
  });

  it('does not send from an empty field', async () => {
    const rendered = await openSheet();

    act(() => {
      headerProps(rendered).onDone();
    });

    expect(invite.mutate).not.toHaveBeenCalled();
    rendered.unmount();
  });
});

const ROLE_TEXTS: Record<string, true> = { member: true, billing_manager: true, owner: true };

function isRoleLabel(child: unknown): child is string {
  return typeof child === 'string' && ROLE_TEXTS[child] === true;
}

/** The role labels the sheet draws, in screen order. */
function roleLabels(rendered: RenderWithProvidersResult): string[] {
  return rendered.renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => node.props.children)
    .filter(child => isRoleLabel(child));
}

describe('InviteMemberSheet roles', () => {
  it('offers an owner the owner row', async () => {
    boundary.role = 'owner';
    const rendered = await openSheet();

    expect(roleLabels(rendered)).toEqual(['member', 'billing_manager', 'owner']);
    rendered.unmount();
  });

  it('does not offer an admin the owner row the server always refuses', async () => {
    boundary.role = 'admin';
    const rendered = await openSheet();

    expect(roleLabels(rendered)).toEqual(['member', 'billing_manager']);
    rendered.unmount();
  });

  it('submits the plain member role to a billing manager', async () => {
    boundary.role = 'billing_manager';
    const rendered = await openSheet();

    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      headerProps(rendered).onDone();
    });

    expect(invite.mutate).toHaveBeenCalledWith(
      { email: 'dev@example.com', role: 'member' },
      expect.anything()
    );
    rendered.unmount();
  });

  it('never submits a selection the caller lost the authority for', async () => {
    boundary.role = 'owner';
    const rendered = await openSheet();
    act(() => {
      roleRowProps(rendered, 2).onPress();
    });
    expect(roleLabels(rendered)).toContain('owner');

    // The membership changed underneath the open form: an admin cannot assign
    // owner, and the row is gone from the list.
    boundary.role = 'admin';
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    expect(roleLabels(rendered)).toEqual(['member', 'billing_manager']);

    act(() => {
      headerProps(rendered).onDone();
    });

    expect(invite.mutate).toHaveBeenCalledWith(
      { email: 'dev@example.com', role: 'member' },
      expect.anything()
    );
    rendered.unmount();
  });
});

describe('InviteMemberSheet dismissal', () => {
  it('dismisses the route once when the invite succeeds', async () => {
    const rendered = await openSheet();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      headerProps(rendered).onDone();
    });

    const [, options] = invite.mutate.mock.calls[0] as [unknown, { onSuccess: () => void }];
    act(() => {
      options.onSuccess();
    });

    expect(popOnce).toHaveBeenCalledOnce();
    rendered.unmount();
  });

  it('keeps the sheet up while the invite is in flight', async () => {
    const rendered = await openSheet();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      headerProps(rendered).onDone();
    });
    invite.isPending = true;
    // A real render is what re-reads the pending flag the Back handler
    // consults: clear the field, which changes canSubmit, then retype it.
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });

    let consumed = false;
    act(() => {
      consumed = backPress.handler?.() ?? false;
    });

    expect(consumed).toBe(true);
    expect(guard.requestClose).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('asks the discard guard on Back when nothing is in flight', async () => {
    const rendered = await openSheet();

    act(() => {
      backPress.handler?.();
    });

    expect(guard.requestClose).toHaveBeenCalledOnce();
    rendered.unmount();
  });
});
