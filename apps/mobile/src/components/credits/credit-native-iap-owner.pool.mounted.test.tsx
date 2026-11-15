import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@/test/renderer';

import {
  closePoolOwners,
  emitNativeError,
  emitNativePurchase,
  flushPool,
  mountPoolOwner,
  nativePurchase,
  ownerValue,
  pack,
  type PoolOwner,
  resetPool,
  store,
} from './credit-native-iap-owner.pool.test-helpers';

beforeEach(() => {
  resetPool();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(closePoolOwners);

async function dispatchAfterConsent(owner: PoolOwner): Promise<{ completion: Promise<boolean> }> {
  const first = ownerValue(owner).purchase(pack);
  await flushPool();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000);
  });
  expect(await first).toBe(false);
  await ownerValue(owner).purchase(pack);
  expect(ownerValue(owner).buyAgainProductId).toBe(pack.storeProductId);
  const completion = ownerValue(owner).buyAgain(pack);
  await flushPool();
  expect(store.requestPurchase).toHaveBeenCalledTimes(2);
  expect(store.pending.size).toBe(2);
  return { completion };
}

describe('native purchase promise pool ownership', () => {
  it('keeps B admitted when A cancellation rejects every pooled promise', async () => {
    const owner = await mountPoolOwner();
    const { completion } = await dispatchAfterConsent(owner);
    emitNativeError({ code: 'user-cancelled', message: 'A was cancelled' });
    await completion;
    await vi.advanceTimersByTimeAsync(16_000);
    await flushPool();
    void ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(2);
    expect(ownerValue(owner).buyAgainProductId).toBe(pack.storeProductId);
  });

  it('recovers A once when its result resolves A and B without retiring B', async () => {
    const owner = await mountPoolOwner();
    const { completion } = await dispatchAfterConsent(owner);
    emitNativePurchase(nativePurchase('old-A'));
    await completion;
    await flushPool();
    await vi.advanceTimersByTimeAsync(16_000);
    void ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.complete).toHaveBeenCalledTimes(1);
    expect(store.requestPurchase).toHaveBeenCalledTimes(2);
    expect(ownerValue(owner).buyAgainProductId).toBe(pack.storeProductId);
  });

  it('retains the only purchase when native cleanup rejects it with ServiceDisconnected', async () => {
    const owner = await mountPoolOwner();
    const first = ownerValue(owner).purchase(pack);
    await flushPool();
    emitNativeError({ code: 'service-disconnected', message: 'connection cleanup' });
    await first;
    void ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(1);
    expect(ownerValue(owner).buyAgainProductId).toBe(pack.storeProductId);
  });

  it('releases an unambiguous single purchase cancellation without consent', async () => {
    const owner = await mountPoolOwner();
    const first = ownerValue(owner).purchase(pack);
    await flushPool();
    emitNativeError({ code: 'user-cancelled', message: 'the current purchase was cancelled' });
    expect(await first).toBe(false);
    expect(ownerValue(owner).completingProductId).toBeNull();
    expect(ownerValue(owner).unresolvedProductId).toBeNull();
    void ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(2);
  });
});
