import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFetch, type Env } from './publish-usage';
import { usage } from './usage.test-fixture';

afterEach(() => vi.restoreAllMocks());

describe('production ingress timing', () => {
  it.each([
    { random: 0, duration: 10, fail: false, logged: true },
    { random: 0.5, duration: 10, fail: false, logged: false },
    { random: 0.01, duration: 999.5, fail: false, logged: false },
    { random: 0.5, duration: 1000, fail: false, logged: true },
    { random: 0.5, duration: 10, fail: true, logged: true },
  ])(
    'reports only selected, slow or failed sends: $random $duration $fail',
    async ({ random, duration, fail, logged }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      vi.spyOn(performance, 'now')
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(10 + duration);
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const send = fail
        ? vi.fn().mockRejectedValue(new Error('secret'))
        : vi.fn().mockResolvedValue(undefined);
      const env = {
        USAGE_INGEST_PUBLISH_SECRET: 'secret',
        USAGE_INGEST_QUEUE: { send },
      } as unknown as Env;
      const response = await handleFetch(
        new Request('https://test.invalid/usage', {
          method: 'POST',
          headers: { authorization: 'Bearer secret' },
          body: JSON.stringify(usage),
        }),
        env
      );
      expect(response.status).toBe(fail ? 503 : 202);
      expect(send).toHaveBeenCalledTimes(1);
      const calls = [...info.mock.calls, ...warn.mock.calls];
      expect(calls).toHaveLength(logged ? 1 : 0);
      if (logged)
        expect(JSON.parse(String(calls[0][0]))).toEqual({
          level: fail ? 'warn' : 'info',
          event: 'usage_ingest_enqueue',
          usage_id: usage.core.id,
          outcome: fail ? 'unavailable' : 'accepted',
          send_duration_ms: duration,
        });
    }
  );

  it.each([false, true])('isolates a throwing log sink when failure is %s', async fail => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, fail ? 'warn' : 'info').mockImplementation(() => {
      throw new Error('sink');
    });
    const send = fail
      ? vi.fn().mockRejectedValue(new Error('queue'))
      : vi.fn().mockResolvedValue(undefined);
    const env = {
      USAGE_INGEST_PUBLISH_SECRET: 'secret',
      USAGE_INGEST_QUEUE: { send },
    } as unknown as Env;
    const response = await handleFetch(
      new Request('https://test.invalid/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify(usage),
      }),
      env
    );
    expect(response.status).toBe(fail ? 503 : 202);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
