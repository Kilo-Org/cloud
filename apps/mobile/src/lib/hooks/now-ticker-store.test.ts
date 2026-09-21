import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNowTicker, resetNowTickersForTests } from './now-ticker-store';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z').getTime();

describe('now-ticker-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    resetNowTickersForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shares one timer and one snapshot for consumers of the same interval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const first = getNowTicker(1000);
    const second = getNowTicker(1000);

    expect(second).toBe(first);

    const firstListener = vi.fn<() => void>();
    const secondListener = vi.fn<() => void>();
    first.subscribe(firstListener);
    const snapshot = first.getSnapshot();
    second.subscribe(secondListener);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(second.getSnapshot()).toBe(snapshot);
  });

  it('keeps the snapshot stable between ticks and advances it on a tick', () => {
    const ticker = getNowTicker(1000);
    const listener = vi.fn<() => void>();
    ticker.subscribe(listener);

    const before = ticker.getSnapshot();
    expect(before).toBe(BASE_TIME);
    expect(ticker.getSnapshot()).toBe(before);
    expect(ticker.getSnapshot()).toBe(before);

    vi.advanceTimersByTime(999);
    expect(listener).not.toHaveBeenCalled();
    expect(ticker.getSnapshot()).toBe(before);

    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ticker.getSnapshot()).toBe(BASE_TIME + 1000);
  });

  it('does not re-derive the snapshot from the wall clock between ticks', () => {
    const ticker = getNowTicker(1000);
    ticker.subscribe(vi.fn<() => void>());
    const before = ticker.getSnapshot();

    vi.setSystemTime(BASE_TIME + 250);
    vi.setSystemTime(BASE_TIME + 750);

    // An inline `Date.now()` here would hand `useSyncExternalStore` a new value
    // on every render and re-render forever.
    expect(ticker.getSnapshot()).toBe(before);
  });

  it('notifies every listener exactly once per tick', () => {
    const ticker = getNowTicker(1000);
    const firstListener = vi.fn<() => void>();
    const secondListener = vi.fn<() => void>();
    ticker.subscribe(firstListener);
    ticker.subscribe(secondListener);

    vi.advanceTimersByTime(1000);
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(2);
  });

  it('gives different intervals separate tickers and separate timers', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const minuteTicker = getNowTicker(60_000);
    const tenSecondTicker = getNowTicker(10_000);

    expect(tenSecondTicker).not.toBe(minuteTicker);

    minuteTicker.subscribe(vi.fn<() => void>());
    tenSecondTicker.subscribe(vi.fn<() => void>());

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy.mock.calls.map(call => call[1])).toEqual([60_000, 10_000]);
  });

  it('clears the timer on the last unsubscribe and starts fresh state on remount', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const ticker = getNowTicker(1000);
    const firstUnsubscribe = ticker.subscribe(vi.fn<() => void>());
    const secondUnsubscribe = ticker.subscribe(vi.fn<() => void>());

    vi.advanceTimersByTime(3000);
    const snapshot = ticker.getSnapshot();
    expect(snapshot).toBe(BASE_TIME + 3000);

    secondUnsubscribe();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    firstUnsubscribe();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(BASE_TIME + 8000);
    const fresh = getNowTicker(1000);
    expect(fresh).not.toBe(ticker);

    fresh.subscribe(vi.fn<() => void>());
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(fresh.getSnapshot()).toBe(BASE_TIME + 8000);
  });

  it('resetNowTickersForTests stops timers and empties the registry', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const ticker = getNowTicker(1000);
    ticker.subscribe(vi.fn<() => void>());

    resetNowTickersForTests();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    const replacement = getNowTicker(1000);
    expect(replacement).not.toBe(ticker);
  });
});
