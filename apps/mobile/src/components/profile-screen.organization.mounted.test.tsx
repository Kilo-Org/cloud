import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  authState,
  findConfigureRows,
  findNode,
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
import { contextPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { act } from '@/test/renderer';
import { createTestQueryClient, waitFor } from '@/test/render-with-providers';

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

    // The row opens the shared account picker route, and the route is handed
    // Personal first, then both memberships, with the current account marked.
    expect(routerPush).toHaveBeenCalledWith('/(app)/context-picker');
    const bridge = contextPickerSlot.get(UNFENCED_ROUTE_KEY);
    if (bridge === undefined) {
      throw new Error('the account picker route was not handed a bridge');
    }
    expect(bridge.options).toEqual([i18n.t('common.personal'), 'Kilo', 'Acme']);
    expect(bridge.currentIndex).toBe(0);

    act(() => {
      bridge.onSelect(2);
    });

    expect(setOrganizationIdFn).toHaveBeenCalledWith('org-2');
    // Choosing stays on Profile; the section renders the chosen organization's
    // row once the context publishes instead of navigating away.
    expect(routerPush).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('keeps the section when a selected organization switches to Personal with memberships listed', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
    ]);

    const queryClient = createTestQueryClient();
    const { renderer, unmount } = await mountProfile(queryClient);
    const root = renderer.root;

    flushIdle();
    const chooserTitle = i18n.t('organization.boundary.selectOrganization');
    await waitFor(() => findConfigureRows(root, i18n.t('profile.manageOrganization')).length === 1);

    // The mocked context reads its state at render time, so the cache write is
    // what re-renders the screen after the context switches to Personal.
    act(() => {
      organizationState.organizationId = null;
      queryClient.setQueryData(keys.organizations, [
        { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
      ]);
    });

    await waitFor(() => findConfigureRows(root, chooserTitle).length === 1);

    expect(nodeCountWithChildren(root, 'Text', i18n.t('common.organization'))).toBe(1);
    expect(findConfigureRows(root, i18n.t('profile.manageOrganization'))).toHaveLength(0);
    expect(findConfigureRows(root, chooserTitle)).toHaveLength(1);

    unmount();
  });

  it('keeps the Organization section and its retry when the memberships read fails', async () => {
    organizationState.organizationId = null;
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockRejectedValue(new Error('memberships unavailable'));

    const { renderer, unmount } = await mountProfile();
    const root = renderer.root;

    flushIdle();
    await waitFor(() => nodeCount(root, 'QueryError') === 1);

    expect(nodeCountWithChildren(root, 'Text', i18n.t('common.organization'))).toBe(1);
    const error = findNode(root, 'QueryError');
    expect(error?.props.title).toBe(i18n.t('profile.couldNotLoadOrganization'));
    expect(
      findConfigureRows(root, i18n.t('organization.boundary.selectOrganization'))
    ).toHaveLength(0);

    const callsBeforeRetry = organizationsQueryFn.mock.calls.length;
    act(() => {
      (error?.props as { onRetry?: () => void } | undefined)?.onRetry?.();
    });

    await waitFor(() => organizationsQueryFn.mock.calls.length > callsBeforeRetry);

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
