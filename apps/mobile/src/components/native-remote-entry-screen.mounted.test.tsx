import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { NativeRemoteEntryScreen } from './native-remote-entry-screen';

const mocks = vi.hoisted(() => ({
  token: 'native-token' as string | undefined,
  authEpoch: 1,
  isSigningOut: false,
  organizationId: null as string | null,
  isLoaded: true,
  url: 'http://localhost:8817' as string | undefined,
  client: vi.fn(function NativeClient() {
    return {};
  }),
  demo: vi.fn(() => null),
  redirect: vi.fn(() => null),
  credential: vi.fn(),
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({ NativeSyncClient: mocks.client }));
vi.mock('expo-router', () => ({ Redirect: mocks.redirect }));
vi.mock('@/components/native-remote/native-remote-demo', () => ({ NativeRemoteDemo: mocks.demo }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => mocks }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => mocks }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/lib/config', () => ({
  get SESSION_SYNC_URL() {
    return mocks.url;
  },
}));
vi.mock('@/lib/native-remote-credential', () => ({ nativeRemoteCredential: mocks.credential }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__DEV__', true);
  mocks.token = 'native-token';
  mocks.authEpoch = 1;
  mocks.isSigningOut = false;
  mocks.organizationId = null;
  mocks.isLoaded = true;
  mocks.url = 'http://localhost:8817';
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount(): ReactTestRenderer {
  const created: ReactTestRenderer[] = [];
  act(() => {
    created.push(TestRenderer.create(createElement(NativeRemoteEntryScreen)));
  });
  const [renderer] = created;
  if (!renderer) {
    throw new Error('Screen did not mount');
  }
  return renderer;
}

const REFUSALS = {
  production: () => {
    vi.stubGlobal('__DEV__', false);
  },
  endpoint: () => {
    mocks.url = undefined;
  },
  token: () => {
    mocks.token = undefined;
  },
  'sign-out': () => {
    mocks.isSigningOut = true;
  },
};

describe('native remote entry', () => {
  it.each(Object.entries(REFUSALS))('refuses %s without creating a client', (_name, refuse) => {
    refuse();
    const renderer = mount();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('waits for restored scope and forwards the selected organization without replacing credentials', () => {
    mocks.isLoaded = false;
    const renderer = mount();
    expect(mocks.client).not.toHaveBeenCalled();
    mocks.isLoaded = true;
    mocks.organizationId = 'org-owned';
    act(() => {
      renderer.update(createElement(NativeRemoteEntryScreen));
    });
    expect(mocks.demo).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationID: 'org-owned' }),
      undefined
    );
    mocks.organizationId = null;
    act(() => {
      renderer.update(createElement(NativeRemoteEntryScreen));
    });
    expect(mocks.demo).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationID: undefined }),
      undefined
    );
    expect(mocks.client).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps refreshes on one client and replaces it for a new account epoch', () => {
    const renderer = mount();
    expect(mocks.client).toHaveBeenCalledTimes(1);
    mocks.token = 'refreshed-native-token';
    act(() => {
      renderer.update(createElement(NativeRemoteEntryScreen));
    });
    expect(mocks.client).toHaveBeenCalledTimes(1);
    mocks.authEpoch = 2;
    act(() => {
      renderer.update(createElement(NativeRemoteEntryScreen));
    });
    expect(mocks.client).toHaveBeenCalledTimes(2);
    vi.stubGlobal('__DEV__', false);
    act(() => {
      renderer.update(createElement(NativeRemoteEntryScreen));
    });
    expect(mocks.redirect).toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});
