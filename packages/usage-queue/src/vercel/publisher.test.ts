import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { send } from '@vercel/queue';
import { enqueueVercelUsage, VERCEL_USAGE_PUBLISH_TIMEOUT_MS } from './publisher';
import { payload } from './fixture';
import { signUsageMessage } from './message';

vi.mock('@vercel/queue', () => ({ send: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('USAGE_WRITER_SECRET', 'synthetic-writer-secret');
  vi.mocked(send).mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('awaits durable acceptance and preserves the usage ID', async () => {
  const pending = Promise.withResolvers<{ messageId: string }>();
  const started = Promise.withResolvers<void>();
  vi.mocked(send).mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const result = enqueueVercelUsage(payload);
  await started.promise;
  expect(send).toHaveBeenCalledWith(
    'usage-staging',
    await signUsageMessage(payload, 'synthetic-writer-secret'),
    {
      region: 'fra1',
      retentionSeconds: 86400,
      idempotencyKey: payload.core.id,
    }
  );
  pending.resolve({ messageId: 'synthetic-message' });
  await expect(result).resolves.toEqual({ kind: 'accepted' });
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'])(
  'deadline reports ambiguous acceptance, handles late %s',
  async late => {
    const pending = Promise.withResolvers<{ messageId: string }>();
    const started = Promise.withResolvers<void>();
    vi.mocked(send).mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const result = enqueueVercelUsage(payload);
    await started.promise;
    await vi.advanceTimersByTimeAsync(VERCEL_USAGE_PUBLISH_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ kind: 'unavailable', reason: 'acceptance_unknown' });
    if (late === 'resolve') pending.resolve({ messageId: 'late-message' });
    else pending.reject(new Error('SECRET'));
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('SECRET');
  }
);

test('SDK errors are categorical and never logged verbatim', async () => {
  vi.mocked(send).mockRejectedValue(new Error('SECRET prompt header token'));
  await expect(enqueueVercelUsage(payload)).resolves.toEqual({
    kind: 'unavailable',
    reason: 'publish_failed',
  });
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('SECRET');
});

test('missing signing configuration fails before any publish', async () => {
  vi.stubEnv('USAGE_WRITER_SECRET', '');
  await expect(enqueueVercelUsage(payload)).resolves.toEqual({
    kind: 'unavailable',
    reason: 'publish_failed',
  });
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('a signing deadline cannot start a new SDK send after publication has timed out', async () => {
  const signing = Promise.withResolvers<ArrayBuffer>();
  const started = Promise.withResolvers<void>();
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(() => {
    started.resolve();
    return signing.promise;
  });
  const result = enqueueVercelUsage(payload);
  await started.promise;
  await vi.advanceTimersByTimeAsync(VERCEL_USAGE_PUBLISH_TIMEOUT_MS);
  await expect(result).resolves.toEqual({ kind: 'unavailable', reason: 'acceptance_unknown' });
  signing.resolve(new Uint8Array(32).buffer);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
