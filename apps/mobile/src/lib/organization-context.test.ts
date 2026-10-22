/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { type QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationProvider, useOrganization } from './organization-context';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
// The recovery toast resolves catalog copy; the suite needs the real i18n
// singleton so the asserted strings are the English catalog's, not key names.
import '@/i18n';

const hoisted = vi.hoisted(() => ({
  useAuth: vi.fn(),
  setAccountMetadata: vi.fn(),
  deleteAccountMetadata: vi.fn(),
  writePrivacySnapshotAndEnd: vi.fn(),
  unregisterActivityTokensAndTombstone: vi.fn(),
  getItemAsync: vi.fn(),
  list: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: hoisted.useAuth,
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: hoisted.toastWarning },
}));

vi.mock('@/lib/auth/account-metadata-write', () => ({
  setAccountMetadata: hoisted.setAccountMetadata,
  deleteAccountMetadata: hoisted.deleteAccountMetadata,
}));

vi.mock('@/lib/glanceable/cleanup', () => ({
  writePrivacySnapshotAndEnd: hoisted.writePrivacySnapshotAndEnd,
}));

vi.mock('@/lib/auth/logout-cleanup', () => ({
  unregisterActivityTokensAndTombstone: hoisted.unregisterActivityTokensAndTombstone,
}));

// The provider resolves its default from the same `organizations.list` query
// `context-control.mounted.test.tsx` mocks.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: hoisted.list }) },
    },
  }),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: hoisted.getItemAsync,
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

type OrganizationContextValue = {
  organizationId: string | null;
  isLoaded: boolean;
  setOrganizationId: (id: string | null) => void;
};

async function mountProvider(): Promise<{
  getCtx: () => OrganizationContextValue;
  queryClient: QueryClient;
  unmount: () => void;
}> {
  let capturedCtx: OrganizationContextValue | undefined = undefined;
  function Consumer(): null {
    capturedCtx = useOrganization();
    return null;
  }

  const ui = await renderWithProviders(createElement(Consumer), { wrapper: OrganizationProvider });
  // Let the provider's restore read settle. The list may still be pending, so
  // this only guarantees the read decided whether a default resolution is owed.
  await act(async () => {
    await new Promise(resolve => {
      void setTimeout(resolve, 0);
    });
  });

  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
  if (!capturedCtx) {
    throw new Error('organization context not captured');
  }

  return {
    getCtx: () => {
      // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
      if (!capturedCtx) {
        throw new Error('organization context not captured');
      }
      return capturedCtx;
    },
    queryClient: ui.queryClient,
    unmount: ui.unmount,
  };
}

describe('OrganizationProvider.setOrganizationId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.useAuth.mockReturnValue({ token: 't' });
    hoisted.getItemAsync.mockResolvedValue(null);
    hoisted.list.mockResolvedValue([]);
    hoisted.setAccountMetadata.mockResolvedValue(undefined);
    hoisted.deleteAccountMetadata.mockResolvedValue(undefined);
    hoisted.unregisterActivityTokensAndTombstone.mockResolvedValue(undefined);
  });

  it('blanks, unregisters the prior org activity tokens, and persists the new selection', async () => {
    const { getCtx, unmount } = await mountProvider();

    await act(() => {
      getCtx().setOrganizationId('org-2');
    });

    expect(hoisted.writePrivacySnapshotAndEnd).toHaveBeenCalledTimes(1);
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(1);
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-2');
    expect(hoisted.deleteAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_PERSONAL_STORAGE_KEY);
    expect(getCtx().organizationId).toBe('org-2');

    unmount();
  });

  it('no-ops a same-value org selection', async () => {
    const { getCtx, unmount } = await mountProvider();

    await act(() => {
      getCtx().setOrganizationId('org-2');
    });
    await act(() => {
      getCtx().setOrganizationId('org-2');
    });

    expect(hoisted.writePrivacySnapshotAndEnd).toHaveBeenCalledTimes(1);
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(1);
    expect(hoisted.setAccountMetadata).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('stores the Personal choice as the selection value', async () => {
    const { getCtx, unmount } = await mountProvider();

    await act(() => {
      getCtx().setOrganizationId('org-2');
    });
    await act(() => {
      getCtx().setOrganizationId(null);
    });

    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'personal');
    expect(hoisted.deleteAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_PERSONAL_STORAGE_KEY);
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(2);
    expect(getCtx().organizationId).toBeNull();

    unmount();
  });

  it('keeps an explicit Personal choice when a default organization is pending', async () => {
    const names = Promise.withResolvers<{ organizationId: string }[]>();
    hoisted.list.mockReturnValue(names.promise);

    const { getCtx, unmount } = await mountProvider();

    await act(() => {
      getCtx().setOrganizationId(null);
    });
    await act(() => {
      names.resolve([{ organizationId: 'org-a' }]);
    });

    expect(getCtx().organizationId).toBeNull();
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'personal');

    unmount();
  });
});

describe('OrganizationProvider lost-membership recovery', () => {
  /** Stores the recovered fixture selection; every other key reads absent. */
  const storeSelection = (): void => {
    hoisted.getItemAsync.mockImplementation(async key => {
      const stored = key === ORGANIZATION_STORAGE_KEY ? 'org-lost' : null;
      await Promise.resolve();
      return stored;
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.useAuth.mockReturnValue({ token: 't' });
    hoisted.setAccountMetadata.mockResolvedValue(undefined);
    hoisted.deleteAccountMetadata.mockResolvedValue(undefined);
    hoisted.unregisterActivityTokensAndTombstone.mockResolvedValue(undefined);
  });

  /** Swaps the list payload and refetches the shared query inside act. */
  async function refetchListWith(
    queryClient: QueryClient,
    next: { organizationId: string; organizationName: string; role: string }[]
  ): Promise<void> {
    hoisted.list.mockResolvedValue(next);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['organizations-list'] });
    });
  }

  it('switches to the first remaining membership and announces the target when the active org drops out of the list', async () => {
    // The stored selection names an organization the list still holds.
    storeSelection();
    hoisted.list.mockResolvedValue([
      { organizationId: 'org-lost', organizationName: 'Doomed org', role: 'member' },
      { organizationId: 'org-kept', organizationName: 'Kept org', role: 'member' },
    ]);
    const { getCtx, queryClient, unmount } = await mountProvider();
    expect(getCtx().organizationId).toBe('org-lost');
    expect(hoisted.toastWarning).not.toHaveBeenCalled();

    // The refreshed list no longer names the selection.
    await refetchListWith(queryClient, [
      { organizationId: 'org-kept', organizationName: 'Kept org', role: 'member' },
    ]);

    // The switch publishes through the effect chain; the notification flush
    // can land a tick after the refetch resolves.
    await waitFor(() => getCtx().organizationId === 'org-kept');
    expect(getCtx().organizationId).toBe('org-kept');
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-kept');
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(1);
    expect(hoisted.toastWarning).toHaveBeenCalledTimes(1);
    expect(hoisted.toastWarning).toHaveBeenCalledWith(
      'You no longer have access to this organization. Switched to Kept org.'
    );

    unmount();
  });

  it('falls back to Personal, stores the choice, and names Personal when no membership remains', async () => {
    storeSelection();
    hoisted.list.mockResolvedValue([
      { organizationId: 'org-lost', organizationName: 'Doomed org', role: 'member' },
    ]);
    const { getCtx, queryClient, unmount } = await mountProvider();

    await refetchListWith(queryClient, []);

    await waitFor(() => getCtx().organizationId === null);
    expect(getCtx().organizationId).toBeNull();
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'personal');
    expect(hoisted.toastWarning).toHaveBeenCalledWith(
      'You no longer have access to this organization. Switched to Personal.'
    );

    unmount();
  });

  it('keeps the selection while the list is loading, failing, or still names the org', async () => {
    storeSelection();
    const pending = Promise.withResolvers<{ organizationId: string }[]>();
    hoisted.list.mockReturnValue(pending.promise);
    const { getCtx, queryClient, unmount } = await mountProvider();
    expect(getCtx().organizationId).toBe('org-lost');

    // A failed list decides nothing: the selection stays, no toast.
    await act(async () => {
      pending.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(getCtx().organizationId).toBe('org-lost');
    expect(hoisted.toastWarning).not.toHaveBeenCalled();

    // A refetch that still names the org changes nothing either.
    await refetchListWith(queryClient, [
      { organizationId: 'org-lost', organizationName: 'Doomed org', role: 'member' },
    ]);
    expect(getCtx().organizationId).toBe('org-lost');
    expect(hoisted.toastWarning).not.toHaveBeenCalled();
    expect(hoisted.setAccountMetadata).not.toHaveBeenCalled();

    unmount();
  });

  it('recovers a stored selection whose very first snapshot already misses it (cold start without read cache)', async () => {
    // The stored selection names an organization no longer in the list: the
    // persisted read cache expired, so the first live snapshot is the baseline.
    storeSelection();
    hoisted.list.mockResolvedValue([
      { organizationId: 'org-kept', organizationName: 'Kept org', role: 'member' },
    ]);
    const { getCtx, unmount } = await mountProvider();

    // The first settled snapshot arms and switches without a prior good list.
    await waitFor(() => getCtx().organizationId === 'org-kept');
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-kept');
    expect(hoisted.toastWarning).toHaveBeenCalledWith(
      'You no longer have access to this organization. Switched to Kept org.'
    );

    unmount();
  });

  it('does not re-switch when the user picks another context during recovery', async () => {
    storeSelection();
    hoisted.list.mockResolvedValue([
      { organizationId: 'org-lost', organizationName: 'Doomed org', role: 'member' },
      { organizationId: 'org-kept', organizationName: 'Kept org', role: 'member' },
    ]);
    const { getCtx, queryClient, unmount } = await mountProvider();

    await refetchListWith(queryClient, [
      { organizationId: 'org-kept', organizationName: 'Kept org', role: 'member' },
    ]);
    await waitFor(() => getCtx().organizationId === 'org-kept');
    expect(getCtx().organizationId).toBe('org-kept');
    const switchCalls = hoisted.setAccountMetadata.mock.calls.length;

    // A manual selection over the recovered context is a plain user switch,
    // not a second recovery: no extra toast, no echo of the lost org.
    await act(() => {
      getCtx().setOrganizationId(null);
    });
    expect(getCtx().organizationId).toBeNull();
    expect(hoisted.toastWarning).toHaveBeenCalledTimes(1);
    expect(hoisted.setAccountMetadata.mock.calls.length).toBe(switchCalls + 1);

    unmount();
  });
});
