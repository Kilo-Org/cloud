import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  authState,
  findConfigureRows,
  flushIdle,
  idleState,
  keys,
  mountProfile,
  nodeCount,
  nodeCountWithChildren,
  organizationsQueryFn,
  organizationState,
  providersQueryFn,
  routerPush,
  setOrganizationIdFn,
} from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { createTestQueryClient, waitFor } from '@/test/render-with-providers';

/** The selected state an account action button carries, if it carries one. */
function selectedState(node: ReactTestInstance): boolean | undefined {
  const state: unknown = node.props.accessibilityState;
  if (typeof state !== 'object' || state === null || !('selected' in state)) {
    return undefined;
  }
  return typeof state.selected === 'boolean' ? state.selected : undefined;
}

describe('ProfileScreen Organization section', () => {
  beforeEach(() => {
    vi.useRealTimers();
    providersQueryFn.mockReset();
    organizationsQueryFn.mockReset();
    routerPush.mockReset();
    authState.token = 'token-1';
    idleState.storedCallback = undefined;
    idleState.cancel.mockReset();
    organizationState.organizationId = 'org-1';
    organizationState.isLoaded = true;
    setOrganizationIdFn.mockReset();
  });

  it('keeps organization management reachable from Profile in Personal context', async () => {
    organizationState.organizationId = null;
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
      { organizationId: 'org-2', organizationName: 'Acme', role: 'member' },
    ]);

    const { renderer, unmount } = await mountProfile();
    const root = renderer.root;

    flushIdle();
    const chooserTitle = i18n.t('organization.boundary.selectOrganization');
    await waitFor(() => findConfigureRows(root, chooserTitle).length === 1);

    // Personal is the credit-account context, and the Organization section is
    // still on Profile with a control that reaches the memberships.
    expect(nodeCountWithChildren(root, 'Text', i18n.t('common.organization'))).toBe(1);
    const row = findConfigureRows(root, chooserTitle)[0];
    expect(row?.props.hue).toBe('lime');
    expect(nodeCount(root, 'BottomSheet')).toBe(0);

    act(() => {
      (row?.props as { onPress?: () => void } | undefined)?.onPress?.();
    });

    // The row opens the app's account picker: Personal first, then both
    // memberships, with the current account marked as selected.
    const rows = root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'button' &&
        selectedState(node) !== undefined
    );
    expect(rows.map(row => row.props.accessibilityLabel)).toEqual([
      i18n.t('common.personal'),
      'Kilo',
      'Acme',
    ]);
    expect(rows[0]?.props.accessibilityState).toMatchObject({ selected: true });

    act(() => {
      (rows[2]?.props as { onPress?: () => void } | undefined)?.onPress?.();
    });

    expect(setOrganizationIdFn).toHaveBeenCalledWith('org-2');
    // Choosing stays on Profile; the section renders the chosen organization's
    // row once the context publishes instead of navigating away.
    expect(routerPush).not.toHaveBeenCalled();

    unmount();
  });

  it('leaves the Organization section hidden in Personal context without memberships', async () => {
    organizationState.organizationId = null;
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    flushIdle();
    await waitFor(
      () => providersQueryFn.mock.calls.length > 0 && organizationsQueryFn.mock.calls.length > 0
    );
    await waitFor(() => nodeCount(renderer.root, 'Skeleton') === 0);

    // Accounts without an organization keep the hub's own boundary; Profile
    // gains no control for them.
    expect(nodeCountWithChildren(renderer.root, 'Text', i18n.t('common.organization'))).toBe(0);
    expect(
      findConfigureRows(renderer.root, i18n.t('organization.boundary.selectOrganization'))
    ).toHaveLength(0);

    unmount();
  });

  it('waits for the organization restore before offering the picker', async () => {
    organizationState.organizationId = null;
    organizationState.isLoaded = false;

    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.providers, { providers: [] });
    queryClient.setQueryData(keys.organizations, [
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
      { organizationId: 'org-2', organizationName: 'Acme', role: 'member' },
    ]);

    const { renderer, unmount } = await mountProfile(queryClient);

    // Cached memberships are already enough to render, but the stored selection
    // has not been restored yet, so the chooser must not paint and then flip to
    // the active organization's row.
    expect(nodeCountWithChildren(renderer.root, 'Text', i18n.t('common.organization'))).toBe(0);
    expect(
      findConfigureRows(renderer.root, i18n.t('organization.boundary.selectOrganization'))
    ).toHaveLength(0);

    unmount();
  });
});
