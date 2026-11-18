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

  it('names a credited pooled delivery as credited, not as found', async () => {
    const owner = await mountPoolOwner();
    const { completion } = await dispatchAfterConsent(owner);
    emitNativePurchase(nativePurchase('credited-pooled'));
    await completion;
    await flushPool();

    expect(ownerValue(owner).hasUnresolvedPurchase).toBe(true);
    expect(ownerValue(owner).purchaseResolution).toBe('credited');
    expect(ownerValue(owner).purchaseWait).toBeNull();
  });

  it('settles an unattributable cancellation at once and keeps the barrier', async () => {
    const owner = await mountPoolOwner();
    const { completion } = await dispatchAfterConsent(owner);
    emitNativeError({ code: 'user-cancelled', message: 'A was cancelled' });
    await completion;
    await flushPool();

    // No timer advance: the row is not left spinning for a charge the store
    // has answered, and the outcome may still be another request's.
    expect(ownerValue(owner).completingProductId).toBeNull();
    expect(ownerValue(owner).hasUnresolvedPurchase).toBe(true);
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

  it('credits an ambiguous consented success, keeps the barrier and ends the consent loop', async () => {
    const owner = await mountPoolOwner();
    const first = ownerValue(owner).purchase(pack);
    await flushPool();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(await first).toBe(false);
    await ownerValue(owner).purchase(pack);
    expect(ownerValue(owner).buyAgainProductId).toBe(pack.storeProductId);

    const consented = ownerValue(owner).buyAgain(pack);
    await flushPool();
    emitNativePurchase(nativePurchase('credited-after-consent'));
    await consented;
    await flushPool();

    // 1. One credit and no dangling progress: the row's UI does not depend on
    // whether the outcome could be attributed.
    expect(store.complete).toHaveBeenCalledTimes(1);
    expect(ownerValue(owner).completingProductId).toBeNull();
    // 2. The barrier stays: the still-pooled earlier request may yet arrive, so
    // the notice names the credit that already landed and offers the retry.
    expect(ownerValue(owner).hasUnresolvedPurchase).toBe(true);
    expect(ownerValue(owner).purchaseResolution).toBe('credited');
    expect(ownerValue(owner).buyAgainProductId).toBe(pack.storeProductId);

    // 3. The next tap reaches consent instead of silently reconciling forever,
    // and the consented request is the pool's only member, so it retires.
    await ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(2);
    const third = ownerValue(owner).buyAgain(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(3);
    emitNativePurchase(nativePurchase('credited-third'));
    await third;
    await flushPool();
    expect(ownerValue(owner).hasUnresolvedPurchase).toBe(false);

    // 4. The loop ends: an ordinary tap charges without consent. The dispatch
    // stays open until the store answers, so the tap is not awaited.
    void ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(4);
  });

  it('releases an unambiguous single purchase cancellation without consent', async () => {
    const owner = await mountPoolOwner();
    const first = ownerValue(owner).purchase(pack);
    await flushPool();
    emitNativeError({ code: 'user-cancelled', message: 'the current purchase was cancelled' });
    expect(await first).toBe(false);
    expect(ownerValue(owner).completingProductId).toBeNull();
    expect(ownerValue(owner).hasUnresolvedPurchase).toBe(false);
    void ownerValue(owner).purchase(pack);
    await flushPool();
    expect(store.requestPurchase).toHaveBeenCalledTimes(2);
  });
});
