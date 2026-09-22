// The Profile route's foreground refresh must not touch the 5-minute
// store-product catalog. The Kilo Pass card on this route renders only the
// purchase presentation and the subscription state; the old `[['kiloPass']]`
// prefix also matched `kiloPass.getMobileStoreProducts`, so returning from the
// Kilo Pass modal marked the catalog invalidated and the next entry re-issued
// the request instead of painting the cached tiers.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileLayout from '@/app/(app)/(tabs)/(3_profile)/_layout';
import { act, TestRenderer } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';

const refresh = vi.hoisted(() => ({ keys: [] as readonly (readonly unknown[])[] }));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: (keys: readonly (readonly unknown[])[]) => {
    refresh.keys = keys;
  },
}));

vi.mock('expo-router', () => ({
  Stack: () => null,
}));

// The tRPC query-key shape for a procedure without input: `[path, { type }]`.
const catalogKey = [['kiloPass', 'getMobileStoreProducts'], { type: 'query' }];
const presentationKey = [['kiloPass', 'getPurchasePresentation'], { type: 'query' }];
const stateKey = [['kiloPass', 'getState'], { type: 'query' }];

async function renderLayout(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(ProfileLayout));
  });
  if (!ref.current) {
    throw new Error('ProfileLayout renderer was not created');
  }
  return ref.current;
}

describe('ProfileLayout route foreground refresh', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    refresh.keys = [];
  });

  it('does not invalidate the 5-minute store-product catalog', async () => {
    const renderer = await renderLayout();
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

  it('still invalidates the queries the Kilo Pass card renders', async () => {
    const renderer = await renderLayout();
    try {
      const queryClient = createTestQueryClient();
      queryClient.setQueryData(presentationKey, {});
      queryClient.setQueryData(stateKey, {});

      for (const key of refresh.keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }

      expect(queryClient.getQueryState(presentationKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(stateKey)?.isInvalidated).toBe(true);
    } finally {
      renderer.unmount();
    }
  });
});
