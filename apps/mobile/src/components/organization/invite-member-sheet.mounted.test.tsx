import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { InviteMemberSheet } from './invite-member-sheet';

type Boundary = {
  organizationId: string | null;
  role: string;
  org: { organizationId: string } | null;
  isResolving: boolean;
};

const boundary = vi.hoisted(
  (): Boundary => ({
    organizationId: 'org-1',
    role: 'owner',
    org: { organizationId: 'org-1' },
    isResolving: false,
  })
);
const invite = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: { message: 'Seat limit reached' },
}));
// The route's focus effects: the sheet registers its form reset and its Back
// handler on every render, and the test re-runs them to present the sheet
// again. `useCallback` keeps each identity stable, so a render adds nothing.
const focus = vi.hoisted(() => ({ effects: [] as (() => void)[] }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
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
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
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
// The sheet's own dirty check: what Cancel and Back would ask about.
const guard = vi.hoisted(() => ({ isDirty: () => false }));
vi.mock('@/components/ui/use-sheet-dismiss-guard', () => ({
  useSheetDismissGuard: (options: { isDirty: () => boolean }) => {
    guard.isDirty = options.isDirty;
    return { requestClose: vi.fn(), requestDismiss: () => true, dialog: null };
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
  isMoneyRole: (role: string) => role === 'owner' || role === 'billing_manager',
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
  invite.mutate.mockClear();
  invite.reset.mockClear();
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

    // The earlier attempt fails after the reopen: its error belongs to the
    // previous form, not to the one on screen now.
    invite.isPending = false;
    invite.isError = true;
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });

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

    expect(inviteMessage(rendered)).toBe('Seat limit reached');
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
