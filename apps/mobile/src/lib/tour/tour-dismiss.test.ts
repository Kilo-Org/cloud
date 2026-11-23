import { type Href } from 'expo-router';
import { describe, expect, it, vi } from 'vitest';

import { dismissTour, HOME_TAB_ROOT } from './tour-dismiss';

function makeRouter(canGoBack: boolean) {
  return {
    canGoBack: vi.fn((): boolean => canGoBack),
    back: vi.fn((): void => undefined),
  };
}

describe('dismissTour', () => {
  it('pops when the tour has a screen beneath it', () => {
    const router = makeRouter(true);
    const replace = vi.fn<(href: Href) => void>();

    dismissTour(router, replace);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('lands on Home when nothing can handle a GO_BACK beneath the tour', () => {
    const router = makeRouter(false);
    const replace = vi.fn<(href: Href) => void>();

    dismissTour(router, replace);

    // The swap is the caller's stack-safe replace: a literal `router.replace`
    // there is the Android Fabric `addViewAt` crash.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(HOME_TAB_ROOT);
    // The unhandled GO_BACK is the defect: it leaves the modal up and raises
    // the development-only banner over the action bar.
    expect(router.back).not.toHaveBeenCalled();
  });
});
