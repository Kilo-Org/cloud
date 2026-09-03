/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  useAuth: vi.fn(),
  setAccountMetadata: vi.fn(),
  deleteAccountMetadata: vi.fn(),
  writePrivacySnapshotAndEnd: vi.fn(),
  unregisterActivityTokensAndTombstone: vi.fn(),
  getItemAsync: vi.fn(),
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

vi.mock('@/lib/storage-keys', () => ({
  ORGANIZATION_STORAGE_KEY: 'organization',
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
  vi.resetModules();
  const mod = await import('./organization-context');

  let capturedCtx: OrganizationContextValue | undefined = undefined;
  function Consumer(): null {
    capturedCtx = mod.useOrganization();
    return null;
  }

  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(mod.OrganizationProvider, null, createElement(Consumer))
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise<void>(resolve => {
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
    unmount: () => {
      renderer?.unmount();
    },
  };
}

describe('OrganizationProvider.setOrganizationId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.useAuth.mockReturnValue({ token: 't' });
    hoisted.getItemAsync.mockResolvedValue(null);
    hoisted.setAccountMetadata.mockResolvedValue(undefined);
    hoisted.deleteAccountMetadata.mockResolvedValue(undefined);
    hoisted.unregisterActivityTokensAndTombstone.mockResolvedValue(undefined);
  });

  it('blanks, unregisters the prior org activity tokens, and persists the new selection', async () => {
    const { getCtx, unmount } = await mountProvider();

    act(() => {
      getCtx().setOrganizationId('org-2');
    });

    expect(hoisted.writePrivacySnapshotAndEnd).toHaveBeenCalledTimes(1);
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(1);
    expect(hoisted.setAccountMetadata).toHaveBeenCalledWith('organization', 'org-2');
    expect(getCtx().organizationId).toBe('org-2');

    unmount();
  });

  it('no-ops a same-value org selection', async () => {
    const { getCtx, unmount } = await mountProvider();

    act(() => {
      getCtx().setOrganizationId('org-2');
    });
    act(() => {
      getCtx().setOrganizationId('org-2');
    });

    expect(hoisted.writePrivacySnapshotAndEnd).toHaveBeenCalledTimes(1);
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(1);
    expect(hoisted.setAccountMetadata).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('clears the persisted org and unregisters tokens when switching to personal', async () => {
    const { getCtx, unmount } = await mountProvider();

    act(() => {
      getCtx().setOrganizationId('org-2');
    });
    act(() => {
      getCtx().setOrganizationId(null);
    });

    expect(hoisted.deleteAccountMetadata).toHaveBeenCalledWith('organization');
    expect(hoisted.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(2);
    expect(getCtx().organizationId).toBeNull();

    unmount();
  });
});
