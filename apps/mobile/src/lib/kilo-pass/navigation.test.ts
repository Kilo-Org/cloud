import { describe, expect, it, vi } from 'vitest';

import { dismissKiloPassAfterPurchase } from './navigation';

describe('dismissKiloPassAfterPurchase', () => {
  it('replaces with profile when the Kilo Pass route has a back stack', () => {
    const router = {
      back: vi.fn(),
      canGoBack: () => true,
      replace: vi.fn(),
    };

    dismissKiloPassAfterPurchase(router);

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/(app)/profile');
  });

  it('replaces with profile when the Kilo Pass route has no back stack', () => {
    const router = {
      back: vi.fn(),
      canGoBack: () => false,
      replace: vi.fn(),
    };

    dismissKiloPassAfterPurchase(router);

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/(app)/profile');
  });
});
