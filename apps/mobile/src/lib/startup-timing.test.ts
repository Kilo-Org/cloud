import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as StartupTimingModule from './startup-timing';

async function freshTiming(): Promise<typeof StartupTimingModule> {
  vi.resetModules();
  const mod = import('./startup-timing');
  // satisfy require-await without return-await
  await Promise.resolve();
  return mod;
}

describe('startup-timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('measures deltas from the first mark and marks are first-wins', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { markStartup, markStartupComplete, takeStartupTimings } = await freshTiming();

    // First mark establishes the origin — its own delta is always 0.
    markStartup('theme_ready');
    vi.advanceTimersByTime(120);
    markStartup('fonts_ready');
    vi.advanceTimersByTime(30);
    // Second mark for the same gate is ignored.
    markStartup('fonts_ready');

    markStartupComplete('app');
    const payload = takeStartupTimings();

    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).theme_ready).toBe(0);
    expect((payload as Record<string, unknown>).fonts_ready).toBe(120);
    expect((payload as Record<string, unknown>).splash_hidden).toBe(150);
  });

  it('returns null for an unfinished launch and is taken exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { markStartup, markStartupComplete, takeStartupTimings } = await freshTiming();

    // Before any markStartupComplete, nothing is ready to send.
    markStartup('auth_ready');
    expect(takeStartupTimings()).toBeNull();

    // After completion, the payload is returned exactly once.
    markStartupComplete('app');
    const first = takeStartupTimings();
    expect(first).not.toBeNull();
    expect((first as Record<string, unknown>).outcome).toBe('app');

    const second = takeStartupTimings();
    expect(second).toBeNull();
  });

  it('first outcome wins when markStartupComplete is called multiple times', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { markStartupComplete, takeStartupTimings } = await freshTiming();

    markStartupComplete('consent');
    vi.advanceTimersByTime(50);
    markStartupComplete('app');

    const payload = takeStartupTimings();
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).outcome).toBe('consent');
    expect((payload as Record<string, unknown>).splash_hidden).toBe(0);
  });
});
