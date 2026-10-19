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
// The route's focus effect: a mounted sheet registers it on every render, and
// the test re-runs the latest one to present the sheet again.
const focus = vi.hoisted(() => ({ effect: null as null | (() => void) }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  useFocusEffect: (effect: () => void) => {
    focus.effect = effect;
  },
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' }));
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
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
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
  focus.effect = null;
});

type FieldProps = {
  onBlur: (event: unknown) => void;
  onChangeText: (value: string) => void;
};
type ButtonProps = { disabled?: boolean; onPress: () => void };

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

function buttonProps(rendered: RenderWithProvidersResult): ButtonProps {
  return hostProps(rendered, 'Button') as ButtonProps;
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

/** Mount, then run the first focus — a fresh mount's state is already clean. */
async function openSheet(): Promise<RenderWithProvidersResult> {
  const rendered = await renderWithProviders(createElement(InviteMemberSheet));
  act(() => {
    focus.effect?.();
  });
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
    expect(buttonProps(rendered).disabled).toBe(false);

    act(() => {
      focus.effect?.();
    });

    expect(errorMessage(rendered)).toBeNull();
    expect(buttonProps(rendered).disabled).toBe(true);
    expect(invite.reset).toHaveBeenCalledOnce();
    rendered.unmount();
  });

  it('validates the empty field again after the reset', async () => {
    const rendered = await openSheet();
    act(() => {
      focus.effect?.();
    });

    act(() => {
      fieldProps(rendered).onBlur({});
    });

    expect(errorMessage(rendered)).toBeTruthy();
    rendered.unmount();
  });

  it('keeps an invite that is still running on the next open, without its error', async () => {
    const rendered = await openSheet();
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      buttonProps(rendered).onPress();
    });
    expect(invite.mutate).toHaveBeenCalledOnce();

    invite.isPending = true;
    act(() => {
      fieldProps(rendered).onChangeText('');
    });
    act(() => {
      fieldProps(rendered).onChangeText('dev@example.com');
    });
    act(() => {
      focus.effect?.();
    });

    expect(invite.reset).not.toHaveBeenCalled();
    expect(buttonProps(rendered).disabled).toBe(true);

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
      buttonProps(rendered).onPress();
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
      buttonProps(rendered).onPress();
    });

    expect(invite.mutate).not.toHaveBeenCalled();
    rendered.unmount();
  });
});
