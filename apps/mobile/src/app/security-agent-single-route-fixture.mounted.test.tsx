// The dev-only fixture renders nothing but a redirect, so every branch must
// hand the reader a real destination. A link that lost its scope, or any link
// opened in a release build, would otherwise leave the reader on a screen that
// renders nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import SecurityAgentSingleRouteFixtureRoute from './security-agent-single-route-fixture';

const router = vi.hoisted(() => ({ replace: vi.fn() }));

// The route reads its params once per render, so the test swaps these two
// fields before mounting instead of stubbing the hook per case.
type Params = { scope?: string | string[]; suffix?: string };

const params = vi.hoisted((): Params => ({}));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useLocalSearchParams: () => params,
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    mounted = TestRenderer.create(<SecurityAgentSingleRouteFixtureRoute />);
  });
  if (!mounted) {
    throw new Error('security agent single-route fixture did not mount');
  }
  return mounted;
}

beforeEach(() => {
  vi.resetAllMocks();
  params.scope = undefined;
  params.suffix = undefined;
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe('security agent single-route fixture', () => {
  it('sends a link with no scope to the app root', () => {
    mount();

    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(app)');
  });

  it('replaces the fixture with the security agent screen the link names', () => {
    params.scope = 'personal';
    params.suffix = 'settings/notifications';

    mount();

    expect(router.replace).toHaveBeenCalledExactlyOnceWith(
      '/(app)/security-agent/personal/settings/notifications'
    );
  });

  it('sends a repeated scope param to the app root', () => {
    params.scope = ['personal', 'acme'];

    mount();

    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(app)');
  });

  it('sends a release build to the app root instead of running the fixture', () => {
    vi.stubGlobal('__DEV__', false);
    params.scope = 'personal';

    mount();

    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(app)');
  });
});
