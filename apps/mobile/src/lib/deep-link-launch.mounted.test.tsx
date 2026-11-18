import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import {
  _resetDeepLinkLaunchForTests,
  _setSecureStoreForTests,
  applyConsumedPendingDeepLink,
  consumePendingDeepLink,
  setPendingDeepLink,
} from './deep-link-launch';

// The provider's session: a signed-in token is enough for `restore()` to read
// the stored selection. The list query is stubbed because the gated consumer's
// switch must not depend on it.
const auth = vi.hoisted(() => ({ token: 't' as string | undefined, isLoading: false }));
const navigate = vi.hoisted(() => vi.fn());

// The provider now announces the lost-membership recovery through the
// toast adapter, whose module graph reaches react-native's Flow source
// the mounted transform cannot parse. Suites mock the adapter (not the
// sonner package) so the mock sits at the edge that imports it.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

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
          // The seeded selection must stay in the fetched list, or the
          // provider's lost-membership recovery switches it away before the
          // deep link under test runs.
          queryFn: () => [
            { organizationId: 'org-1', organizationName: 'Org 1', role: 'owner' },
            { organizationId: 'org-2', organizationName: 'Org 2', role: 'owner' },
          ],
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

/** The provider's published selection, captured on every render of the probe. */
let organizationId: string | null | undefined = undefined;
/** Whether the provider finished its restore, so the tests read a settled value. */
let organizationLoaded = false;
/** The provider's own switch step, passed to the shared consumer as its spy. */
let providerSwitch: ((id: string | null) => void) | undefined = undefined;
const renderers: { unmount: () => void }[] = [];

/**
 * Reads the real provider's state so the assertions see the selection the
 * shared consumer step switched. The step itself lives in the module under
 * test, so nothing here re-implements it.
 */
function OrganizationProbe() {
  const value = useOrganization();
  organizationId = value.organizationId;
  organizationLoaded = value.isLoaded;
  providerSwitch = value.setOrganizationId;
  return null;
}

async function mount() {
  const result = await renderWithProviders(createElement(OrganizationProbe), {
    wrapper: OrganizationProvider,
  });
  renderers.push(result);
  await waitFor(() => organizationLoaded);
  return result;
}

/** The mounted provider's switch, or a failure that names the missing mount. */
function mountedSwitch(): (id: string | null) => void {
  if (providerSwitch === undefined) {
    throw new Error('the organization provider did not mount');
  }
  return providerSwitch;
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
  organizationId = undefined;
  organizationLoaded = false;
  providerSwitch = undefined;
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
    expect(organizationId).toBe('org-1');

    setPendingDeepLink('/(app)/agent-chat/ses_1', 'notification', { organizationId: 'org-2' });
    const switchSpy = vi.fn(mountedSwitch());

    await act(() => {
      applyConsumedPendingDeepLink(consumePendingDeepLink(), switchSpy, href => {
        navigate(href);
      });
    });

    expect(organizationId).toBe('org-2');
    expect(navigate).toHaveBeenCalledWith('/(app)/agent-chat/ses_1');
    expect(switchSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('leaves the selection unchanged for a destination with no organization', async () => {
    await mount();
    expect(organizationId).toBe('org-1');

    setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
    const switchSpy = vi.fn(mountedSwitch());

    await act(() => {
      applyConsumedPendingDeepLink(consumePendingDeepLink(), switchSpy, href => {
        navigate(href);
      });
    });

    expect(organizationId).toBe('org-1');
    expect(navigate).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');
    expect(switchSpy).not.toHaveBeenCalled();
  });
});
