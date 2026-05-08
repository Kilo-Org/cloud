import { describe, expect, it } from 'vitest';

import { ensureProfileAfterKiloPassPurchase } from './navigation';

describe('ensureProfileAfterKiloPassPurchase', () => {
  it('makes profile the top route without resetting the tab stack', () => {
    const routes: unknown[] = [];
    const router: Parameters<typeof ensureProfileAfterKiloPassPurchase>[0] = {
      dismissTo: href => {
        routes.push(href);
      },
    };

    ensureProfileAfterKiloPassPurchase(router);

    expect(routes).toEqual(['/(app)/profile']);
  });
});
