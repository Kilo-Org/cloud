import { describe, expect, it, vi } from 'vitest';

import { resetToProfileAfterKiloPassPurchase } from './navigation';

describe('resetToProfileAfterKiloPassPurchase', () => {
  it('resets to home and opens profile like the home profile button', () => {
    const calls: unknown[] = [];
    const router: Parameters<typeof resetToProfileAfterKiloPassPurchase>[0] = {
      dismissAll: vi.fn(() => {
        calls.push('dismissAll');
      }),
      navigate: href => {
        calls.push(['navigate', href]);
      },
      replace: href => {
        calls.push(['replace', href]);
      },
    };

    resetToProfileAfterKiloPassPurchase(router);

    expect(calls).toEqual([
      'dismissAll',
      ['replace', '/(app)/(tabs)/(0_home)'],
      ['navigate', '/(app)/profile'],
    ]);
  });
});
