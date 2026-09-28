/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { createElement } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationProvider, useOrganization } from './organization-context';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { renderWithProviders } from '@/test/render-with-providers';

const hoisted = vi.hoisted(() => ({
  useAuth: vi.fn(),
  setAccountMetadata: vi.fn(),
  deleteAccountMetadata: vi.fn(),
  writePrivacySnapshotAndEnd: vi.fn(),
  unregisterActivityTokensAndTombstone: vi.fn(),
  getItemAsync: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: hoisted.useAuth,
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

  it('clears the persisted org, unregisters tokens, and marks Personal on the way to personal', async () => {
    const { getCtx, unmount } = await mountProvider();

    await act(() => {
      getCtx().setOrganizationId('org-2');
    });
    await act(() => {
      getCtx().setOrganizationId(null);
    });

    expect(hoisted.deleteAccountMetadata).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(
      ORGANIZATION_PERSONAL_STORAGE_KEY,
      'personal'
    );
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
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith(
      ORGANIZATION_PERSONAL_STORAGE_KEY,
      'personal'
    );

    unmount();
  });
});
