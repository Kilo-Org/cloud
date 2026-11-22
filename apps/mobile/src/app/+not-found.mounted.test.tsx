// A cold deep link to a dead path leaves the not-found route as the only
// screen. Its in-app Back replaces with the app root, and the Android
// hardware/gesture Back must do the same instead of finishing the Activity
// (which drops the user out of the app).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import NotFound from './+not-found';

const router = vi.hoisted(() => ({
  canGoBack: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
}));

// Models React Native's BackHandler as a set of live subscriptions so the test
// can press Back and observe exactly what the screen registered.
const backHandler = vi.hoisted(() => {
  const handlers = new Set<() => boolean>();
  return {
    handlers,
    addEventListener: (_event: string, handler: () => boolean) => {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
        },
      };
    },
  };
});

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native', () => ({ BackHandler: backHandler }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    mounted = TestRenderer.create(<NotFound />);
  });
  if (!mounted) {
    throw new Error('not-found screen did not mount');
  }
  return mounted;
}

function pressHardwareBack(): boolean {
  let handled = false;
  act(() => {
    for (const handler of backHandler.handlers) {
      handled = handler();
    }
  });
  return handled;
}

beforeEach(() => {
  vi.resetAllMocks();
  backHandler.handlers.clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('not-found hardware back', () => {
  it('replaces the dead route with the app root when there is no history', () => {
    router.canGoBack.mockReturnValue(false);
    mount();

    expect(pressHardwareBack()).toBe(true);

    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('lets the navigator pop to the screen beneath when there is history', () => {
    router.canGoBack.mockReturnValue(true);
    mount();

    expect(pressHardwareBack()).toBe(false);

    expect(router.replace).not.toHaveBeenCalled();
  });

  it('drops its listener on unmount', () => {
    router.canGoBack.mockReturnValue(true);
    const renderer = mount();
    expect(backHandler.handlers.size).toBe(1);

    act(() => {
      renderer.unmount();
    });
    mounted = undefined;

    expect(backHandler.handlers.size).toBe(0);
  });
});
