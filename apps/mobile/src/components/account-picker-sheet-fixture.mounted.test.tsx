// The account picker dev fixture draws nothing of its own: once the picker it
// opened is dismissed, the fixture must leave instead of showing a blank page.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountPickerSheetFixture } from './account-picker-sheet-fixture';

const router = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  canGoBack: vi.fn(() => true),
}));
const navigation = vi.hoisted(() => {
  const focusListeners = new Set<() => void>();
  return {
    focusListeners,
    addListener: (_event: 'focus', listener: () => void) => {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    focus() {
      for (const listener of focusListeners) {
        listener();
      }
    },
  };
});
const organizations = vi.hoisted(() => {
  const query: { data: unknown[] | undefined } = { data: undefined };
  return query;
});
const openPicker = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => organizations }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ organizations: { list: { queryOptions: () => ({}) } } }),
}));
vi.mock('@/components/context-control', () => ({ useContextPicker: () => ({ openPicker }) }));

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(AccountPickerSheetFixture));
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('fixture did not render');
  }
  return ref.current;
}

describe('AccountPickerSheetFixture', () => {
  beforeEach(() => {
    router.back.mockClear();
    router.replace.mockClear();
    router.canGoBack.mockReturnValue(true);
    navigation.focusListeners.clear();
    openPicker.mockClear();
    organizations.data = [];
  });

  it('returns to the screen that opened the link once the picker is dismissed', async () => {
    const renderer = await mount();
    expect(openPicker).toHaveBeenCalledOnce();
    expect(router.back).not.toHaveBeenCalled();

    act(() => {
      navigation.focus();
    });

    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
    expect(openPicker).toHaveBeenCalledOnce();
    act(() => {
      renderer.unmount();
    });
  });

  it('replaces itself with the app root when the link had no history', async () => {
    router.canGoBack.mockReturnValue(false);
    const renderer = await mount();

    act(() => {
      navigation.focus();
    });

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/');
    act(() => {
      renderer.unmount();
    });
  });

  it('stays while the account list loads and the picker has not opened', async () => {
    organizations.data = undefined;
    const renderer = await mount();

    act(() => {
      navigation.focus();
    });

    expect(openPicker).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});
