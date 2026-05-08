import { describe, expect, it, vi } from 'vitest';

import { dismissKiloPassAfterPurchase } from './navigation';

describe('dismissKiloPassAfterPurchase', () => {
  it('dismisses the Kilo Pass sheet', () => {
    const router = {
      dismiss: vi.fn(),
    };

    dismissKiloPassAfterPurchase(router);

    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });
});
