// A route that failed parameter validation is a terminal screen, so its only
// control must not guess: it replaces with the in-app parent its caller chose.
// `canGoBack()` cannot be trusted here — a cold deep link renders on top of the
// tab anchor, so it reports history the user never had.

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { InvalidRouteState } from './invalid-route-state';

const router = vi.hoisted(() => ({
  canGoBack: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { action?: React.ReactNode }) =>
    React.createElement('EmptyState', props, props.action),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'min-h-[48px]' }));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    mounted = TestRenderer.create(
      <InvalidRouteState
        backTo={'/(app)/pr-review' as Parameters<typeof InvalidRouteState>[0]['backTo']}
      />
    );
  });
  if (!mounted) {
    throw new Error('invalid route state did not mount');
  }
  return mounted;
}

function pressBack(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    (renderer.root.findByType('Button').props.onPress as () => void)();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('InvalidRouteState Back', () => {
  it('replaces the route with its declared in-app parent', () => {
    router.canGoBack.mockReturnValue(false);
    pressBack(mount());

    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(app)/pr-review');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('does not pop even when the anchor makes canGoBack report history', () => {
    router.canGoBack.mockReturnValue(true);
    pressBack(mount());

    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(app)/pr-review');
    expect(router.back).not.toHaveBeenCalled();
  });
});
