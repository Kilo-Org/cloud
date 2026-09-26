import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import {
  _resetDeepLinkLaunchForTests,
  _setSecureStoreForTests,
  consumePendingDeepLink,
  setPendingDeepLink,
} from './deep-link-launch';

// The provider's session: a signed-in token is enough for `restore()` to read
// the stored selection. The list query is stubbed because the gated consumer's
// switch must not depend on it.
const auth = vi.hoisted(() => ({ token: 't' as string | undefined, isLoading: false }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
// The switch's privacy-snapshot side effect reaches the glanceable publisher
// graph (components / native surfaces); the assertion is the selection, not it.
vi.mock('@/lib/glanceable/cleanup', () => ({ writePrivacySnapshotAndEnd: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: {
        queryOptions: () => ({
          queryKey: ['organizations', 'list'],
          queryFn: () => [],
        }),
      },
    },
  }),
}));

// The provider reads the stored selection through expo-secure-store; the map
// keeps the read and the write observable without the native module.
const secure = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return secure.values.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secure.values.set(key, value);
    await Promise.resolve();
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secure.values.delete(key);
    await Promise.resolve();
  }),
}));

// The pending slot's own durable mirror lives in a second map so a restore read
// never sees the organization key and vice versa.
const pendingStore = new Map<string, string>();

let organization: ReturnType<typeof useOrganization> | undefined = undefined;
let consumeAndNavigate: (() => void) | undefined = undefined;
const renderers: { unmount: () => void }[] = [];

/**
 * The exact consumer `_layout.tsx` runs: get-and-clear the pending destination,
 * switch the organization when it carried one, then navigate. The switch sits
 * before the navigate with nothing awaited between them.
 */
function PendingDeepLinkConsumer() {
  const value = useOrganization();
  organization = value;
  consumeAndNavigate = () => {
    const pending = consumePendingDeepLink();
    if (!pending) {
      return;
    }
    if (pending.organizationId !== null) {
      value.setOrganizationId(pending.organizationId);
    }
    navigate(pending.href);
  };
  return null;
}

async function mount() {
  const result = await renderWithProviders(createElement(PendingDeepLinkConsumer), {
    wrapper: OrganizationProvider,
  });
  renderers.push(result);
  await waitFor(() => organization?.isLoaded === true);
  return result;
}

beforeEach(() => {
  _resetDeepLinkLaunchForTests();
  _setSecureStoreForTests({
    setItemAsync: vi.fn(async (key: string, value: string) => {
      pendingStore.set(key, value);
      await Promise.resolve();
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      pendingStore.delete(key);
      await Promise.resolve();
    }),
    getItemAsync: vi.fn(async (key: string) => {
      await Promise.resolve();
      return pendingStore.get(key) ?? null;
    }),
  });
  pendingStore.clear();
  secure.values.clear();
  secure.values.set(ORGANIZATION_STORAGE_KEY, 'org-1');
  navigate.mockReset();
  organization = undefined;
  consumeAndNavigate = undefined;
});

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

describe('pending deep-link organization switch', () => {
  it('switches the provider to the destination organization before navigating', async () => {
    await mount();
    expect(organization?.organizationId).toBe('org-1');

    setPendingDeepLink('/(app)/agent-chat/ses_1', 'notification', { organizationId: 'org-2' });

    await act(() => {
      consumeAndNavigate?.();
    });

    expect(organization?.organizationId).toBe('org-2');
    expect(navigate).toHaveBeenCalledWith('/(app)/agent-chat/ses_1');
  });

  it('leaves the selection unchanged for a destination with no organization', async () => {
    await mount();
    expect(organization?.organizationId).toBe('org-1');

    setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');

    await act(() => {
      consumeAndNavigate?.();
    });

    expect(organization?.organizationId).toBe('org-1');
    expect(navigate).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');
  });
});
