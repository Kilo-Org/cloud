import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFetch, MAX_USAGE_BYTES, type Env } from './publish-usage';
import { usage } from './usage.test-fixture';

afterEach(() => vi.restoreAllMocks());

describe('production ingress timing', () => {
  it.each([
    { duration: 10, fail: false },
    { duration: 999.5, fail: false },
    { duration: 1000, fail: false },
    { duration: 10, fail: true },
  ])('reports every send with full boundaries: $duration $fail', async ({ duration, fail }) => {
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
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0][0]))).toEqual({
      level: 'info',
      event: 'usage_ingest_enqueue_start',
      usage_id: usage.core.id,
      publisher_entry_at_ms: expect.any(Number),
      before_send_at_ms: expect.any(Number),
    });
    expect(JSON.parse(String(calls[1][0]))).toEqual({
      level: fail ? 'warn' : 'info',
      event: 'usage_ingest_enqueue',
      usage_id: usage.core.id,
      outcome: fail ? 'unavailable' : 'accepted',
      ...(fail
        ? {}
        : {
            publisher_entry_at_ms: expect.any(Number),
            before_send_at_ms: expect.any(Number),
          }),
      after_send_at_ms: expect.any(Number),
      send_duration_ms: Math.round(duration),
    });
  });

  it.each([
    { name: 'missing authorization', status: 401, authorization: undefined, body: '{}' },
    { name: 'invalid JSON', status: 400, authorization: 'Bearer secret', body: '{' },
    {
      name: 'oversized body',
      status: 413,
      authorization: 'Bearer secret',
      body: 'x'.repeat(MAX_USAGE_BYTES + 1),
    },
  ])(
    'rejects $name before emitting enqueue diagnostics',
    async ({ status, authorization, body }) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const send = vi.fn().mockResolvedValue(undefined);
      const env = {
        USAGE_INGEST_PUBLISH_SECRET: 'secret',
        USAGE_INGEST_QUEUE: { send },
      } as unknown as Env;
      const response = await handleFetch(
        new Request('https://test.invalid/usage', {
          method: 'POST',
          headers: authorization ? { authorization } : undefined,
          body,
        }),
        env
      );
      expect(response.status).toBe(status);
      expect(send).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      if (status === 400) {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            level: 'warn',
            event: 'usage_ingest_rejected',
            category: 'malformed_json',
          })
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    }
  );

  it.each([false, true])('isolates a throwing log sink when failure is %s', async fail => {
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
