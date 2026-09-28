import { describe, expect, it, vi } from 'vitest';

import { dismissTour, HOME_TAB_ROOT } from './tour-dismiss';

function makeRouter(canGoBack: boolean) {
  return {
    canGoBack: vi.fn(() => canGoBack),
    back: vi.fn(),
    replace: vi.fn(),
  };
}

describe('dismissTour', () => {
  it('pops when the tour has a screen beneath it', () => {
    const router = makeRouter(true);

    dismissTour(router);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('lands on Home when nothing can handle a GO_BACK beneath the tour', () => {
    const router = makeRouter(false);

    dismissTour(router);

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(HOME_TAB_ROOT);
    // The unhandled GO_BACK is the defect: it leaves the modal up and raises
    // the development-only banner over the action bar.
    expect(router.back).not.toHaveBeenCalled();
  });
});
