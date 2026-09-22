// The Kilo Pass route's foreground refresh must not touch the 5-minute
// store-product catalog. The screen renders the purchase presentation; the old
// `[['kiloPass']]` prefix also matched `kiloPass.getMobileStoreProducts`, so a
// foreground regain re-ran the store chain for data the app already held.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import KiloPassRoute from '@/app/(app)/kilo-pass';
import { act, TestRenderer } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';

const refresh = vi.hoisted(() => ({ keys: [] as readonly (readonly unknown[])[] }));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: (keys: readonly (readonly unknown[])[]) => {
    refresh.keys = keys;
  },
}));

vi.mock('@/components/kilo-pass/kilo-pass-subscription-screen', () => ({
  KiloPassSubscriptionScreen: () => null,
}));

// The tRPC query-key shape for a procedure without input: `[path, { type }]`.
const catalogKey = [['kiloPass', 'getMobileStoreProducts'], { type: 'query' }];
const presentationKey = [['kiloPass', 'getPurchasePresentation'], { type: 'query' }];

async function renderRoute(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(KiloPassRoute));
  });
  if (!ref.current) {
    throw new Error('KiloPassRoute renderer was not created');
  }
  return ref.current;
}

describe('KiloPassRoute route foreground refresh', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    refresh.keys = [];
  });

  it('does not invalidate the 5-minute store-product catalog', async () => {
    const renderer = await renderRoute();
    try {
      const queryClient = createTestQueryClient();
      queryClient.setQueryData(catalogKey, { products: [] });

      for (const key of refresh.keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }

      expect(queryClient.getQueryState(catalogKey)?.isInvalidated).toBe(false);
    } finally {
      renderer.unmount();
    }
  });

  it('still invalidates the presentation the screen renders', async () => {
    const renderer = await renderRoute();
    try {
      const queryClient = createTestQueryClient();
      queryClient.setQueryData(presentationKey, {});

      for (const key of refresh.keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }

      expect(queryClient.getQueryState(presentationKey)?.isInvalidated).toBe(true);
    } finally {
      renderer.unmount();
    }
  });
});
