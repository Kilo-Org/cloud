import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function baseEnv(stub: Record<string, unknown>) {
  return {
    KILOCLAW_INSTANCE: {
      idFromName: (id: string) => id,
      get: () => stub,
    },
    KILOCLAW_AE: { writeDataPoint: vi.fn() },
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    },
  } as never;
}

describe('platform morning-briefing warm-up handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries enable when gateway is warming up and then succeeds', async () => {
    const enableMorningBriefing = vi
      .fn<() => Promise<{ ok: boolean; enabled: boolean }>>()
      .mockRejectedValueOnce(new Error('Gateway not running'))
      .mockResolvedValueOnce({ ok: true, enabled: true });
    const env = baseEnv({ enableMorningBriefing });

    const requestPromise = platform.request(
      '/morning-briefing/enable',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    await vi.runAllTimersAsync();
    const response = await requestPromise;

    expect(response.status).toBe(200);
    expect(enableMorningBriefing).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({ ok: true, enabled: true });
  });

  it('retries disable when gateway is warming up and then succeeds', async () => {
    const disableMorningBriefing = vi
      .fn<() => Promise<{ ok: boolean; enabled: boolean }>>()
      .mockRejectedValueOnce(new Error('Failed to reach gateway'))
      .mockResolvedValueOnce({ ok: true, enabled: false });
    const env = baseEnv({ disableMorningBriefing });

    const requestPromise = platform.request(
      '/morning-briefing/disable',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    await vi.runAllTimersAsync();
    const response = await requestPromise;

    expect(response.status).toBe(200);
    expect(disableMorningBriefing).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({ ok: true, enabled: false });
  });

  it('returns warm-up payload for status timeout instead of 500', async () => {
    const getMorningBriefingStatus = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(
        new Error('Gateway controller request failed: The operation was aborted due to timeout')
      );
    const env = baseEnv({ getMorningBriefingStatus });

    const response = await platform.request('/morning-briefing/status?userId=user-1', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      code: 'gateway_warming_up',
      retryAfterSec: 2,
      reconcileState: 'in_progress',
    });
  });

  it('does not treat 401 as warm-up for enable retries', async () => {
    const enableMorningBriefing = vi
      .fn<() => Promise<{ ok: boolean; enabled: boolean }>>()
      .mockRejectedValue(new Error('Gateway controller request failed (401)'));
    const env = baseEnv({ enableMorningBriefing });

    const response = await platform.request(
      '/morning-briefing/enable',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(response.status).toBe(500);
    expect(enableMorningBriefing).toHaveBeenCalledTimes(1);
  });
});
