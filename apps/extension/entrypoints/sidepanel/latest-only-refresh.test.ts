import { describe, expect, it } from 'vitest';
import { createLatestOnlyRefresh } from './latest-only-refresh';

describe('latest-only refresh control', () => {
  it('marks sequential runs as fresh', async () => {
    const refresh = createLatestOnlyRefresh();

    await expect(refresh.run(() => Promise.resolve('first'))).resolves.toStrictEqual({
      status: 'applied',
      value: 'first',
    });
    await expect(refresh.run(() => Promise.resolve('second'))).resolves.toStrictEqual({
      status: 'applied',
      value: 'second',
    });
    expect(refresh.isLatest(2)).toBe(true);
    expect(refresh.isLatest(1)).toBe(false);
  });

  it('discards out-of-order resolutions so only the latest wins', async () => {
    const refresh = createLatestOnlyRefresh();
    const resolvers: ((value: string) => void)[] = [];

    // eslint-disable-next-line promise/avoid-new -- controlled fixture for out-of-order resolution
    const firstPromise = new Promise<string>(resolve => {
      resolvers[0] = resolve;
    });
    // eslint-disable-next-line promise/avoid-new -- controlled fixture for out-of-order resolution
    const secondPromise = new Promise<string>(resolve => {
      resolvers[1] = resolve;
    });

    const firstRun = refresh.run(() => firstPromise);
    const secondRun = refresh.run(() => secondPromise);

    resolvers[0]?.('stale');
    resolvers[1]?.('fresh');

    await expect(firstRun).resolves.toStrictEqual({ status: 'stale' });
    await expect(secondRun).resolves.toStrictEqual({ status: 'applied', value: 'fresh' });
  });

  it('discards out-of-order rejections so a stale failure does not surface', async () => {
    const refresh = createLatestOnlyRefresh();
    const resolvers: {
      rejectFirst?: (reason?: unknown) => void;
      resolveSecond?: (value: string) => void;
    } = {};

    // eslint-disable-next-line promise/avoid-new -- controlled fixture for stale rejection
    const firstPromise = new Promise<string>((_resolve, reject) => {
      resolvers.rejectFirst = reject;
    });
    // eslint-disable-next-line promise/avoid-new -- controlled fixture for newer success
    const secondPromise = new Promise<string>(resolve => {
      resolvers.resolveSecond = resolve;
    });

    const firstRun = refresh.run(() => firstPromise);
    const secondRun = refresh.run(() => secondPromise);

    resolvers.resolveSecond?.('fresh');
    resolvers.rejectFirst?.(new Error('stale failure'));

    await expect(firstRun).resolves.toStrictEqual({ status: 'stale' });
    await expect(secondRun).resolves.toStrictEqual({ status: 'applied', value: 'fresh' });
  });

  it('surfaces failure only when the rejecting generation is still latest', async () => {
    const refresh = createLatestOnlyRefresh();
    const error = new Error('latest failure');

    await expect(refresh.run(() => Promise.reject(error))).resolves.toStrictEqual({
      error,
      status: 'failed',
    });
  });

  it('exposes begin/isLatest for callers that apply results themselves', () => {
    const refresh = createLatestOnlyRefresh();
    const tokenA = refresh.begin();
    const tokenB = refresh.begin();

    expect(refresh.isLatest(tokenA)).toBe(false);
    expect(refresh.isLatest(tokenB)).toBe(true);
  });
});
