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
  fixture: undefined as string | undefined,
  param: undefined as string | undefined,
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({ NativeSyncClient: mocks.client }));
vi.mock('expo-router', () => ({
  Redirect: mocks.redirect,
  useLocalSearchParams: () => ({ nativeRemoteFixture: mocks.param }),
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/native-remote/native-remote-transcript', () => ({
  NativeRemoteTranscript: 'NativeRemoteTranscript',
}));
vi.mock('@/lib/native-remote/use-native-session', () => ({
  useNativeSession: () => ({ conversation: undefined }),
}));
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
vi.mock('@/lib/native-remote-fixture', () => ({
  nativeRemoteFixtureClient: vi.fn(() => ({})),
  nativeRemoteFixtureSummary: {
    sessionID: 'ses-fixture',
    tenant: { type: 'user', id: 'fixture-owner' },
    live: true,
    createdAt: 1,
  },
  readNativeRemoteFixture: () => mocks.fixture as string | undefined,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__DEV__', true);
  mocks.token = 'native-token';
  mocks.authEpoch = 1;
  mocks.isSigningOut = false;
  mocks.organizationId = null;
  mocks.isLoaded = true;
  mocks.url = 'http://localhost:8817';
  mocks.fixture = undefined;
  mocks.param = undefined;
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

  it('serves the link-selected transcript fixture without an account token', () => {
    // The handler link (`+native-intent.tsx`) selected the fixture state.
    mocks.fixture = 'gaps';
    mocks.token = undefined;
    const renderer = mount();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('NativeRemoteTranscript')).toHaveLength(1);
    act(() => {
      renderer.unmount();
    });
    mocks.fixture = undefined;
  });

  it('serves the param-selected fixture the gate deep link carries', () => {
    mocks.param = 'gaps';
    mocks.token = undefined;
    const renderer = mount();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('NativeRemoteTranscript')).toHaveLength(1);
    act(() => {
      renderer.unmount();
    });
    mocks.param = undefined;
  });

  it('finds no fixture when neither carrier selected one', () => {
    mocks.token = undefined;
    const renderer = mount();
    expect(mocks.redirect).toHaveBeenCalled();
    expect(renderer.root.findAllByType('NativeRemoteTranscript')).toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });
});
