import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecrets } from '../src/client';
import { SecretUnavailableError } from '../src/errors';

const ETAG_1 = '"0123456789abcdef"';
const ETAG_2 = '"fedcba9876543210"';
const ETAG_3 = '"0011223344556677"';
const SECRET = 'O11Y_CF_AE_API_TOKEN';

function ok(etag = ETAG_1, value = 'ae-token'): BundleResult {
  return {
    status: 'ok',
    workload: 'o11y',
    environment: 'production',
    etag,
    stale: false,
    fetchedAt: '2026-11-25T00:00:00.000Z',
    secrets: { [SECRET]: { value, version: 3 } },
    missing: [],
  };
}

function notModified(etag: string, stale = false): BundleResult {
  return { status: 'not_modified', etag, stale, fetchedAt: '2026-11-25T00:05:00.000Z' };
}

function denied(
  reason: 'identity_rejected' | 'unknown_workload' = 'unknown_workload'
): BundleResult {
  return { status: 'denied', reason };
}

function unavailable(
  retryAfterSeconds = 30,
  reason: 'manager_unreachable_no_copy' | 'internal' = 'manager_unreachable_no_copy'
): BundleResult {
  return { status: 'unavailable', reason, retryAfterSeconds };
}

type Transport = (request: BundleRequest) => Promise<BundleResult>;

function hung(): Promise<BundleResult> {
  return new Promise<BundleResult>(() => {});
}

function context() {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    waitUntil(promise: Promise<unknown>) {
      scheduled.push(promise);
    },
  };
}

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean } = { settled: false };
  const settledPromise = promise.then(
    value => {
      state.settled = true;
      return value;
    },
    (error: unknown) => {
      state.settled = true;
      throw error;
    }
  );
  settledPromise.catch(() => {});
  return { state, promise: settledPromise };
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSecrets', () => {
  it('shares one bundle fetch between concurrent readers', async () => {
    const transport = vi.fn<Transport>(async () => ok());
    const secrets = createSecrets(transport);

    const [value, again, snapshot] = await Promise.all([
      secrets.get(SECRET),
      secrets.get(SECRET),
      secrets.snapshot(),
    ]);

    expect(value).toBe('ae-token');
    expect(again).toBe('ae-token');
    expect(snapshot.etag).toBe(ETAG_1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toEqual({});
  });

  it('serves from memory for the first 240 seconds', async () => {
    const transport = vi.fn<Transport>(async () => ok());
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(239);
    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('revalidates in the background after 240 seconds with ifNoneMatch', async () => {
    const pending = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockReturnValueOnce(pending.promise);
    const secrets = createSecrets(transport);
    const ctx = context();

    await secrets.get(SECRET);
    await advance(241);

    expect(await secrets.get(SECRET, ctx)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][0]).toEqual({ ifNoneMatch: ETAG_1 });
    expect(ctx.scheduled).toHaveLength(1);

    pending.resolve(ok(ETAG_2, 'rotated-token'));
    await ctx.scheduled[0];

    expect(await secrets.get(SECRET)).toBe('rotated-token');
    expect((await secrets.snapshot()).etag).toBe(ETAG_2);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('waits for revalidation once the 300 second cache expires', async () => {
    const pending = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockReturnValueOnce(pending.promise);
    const secrets = createSecrets(transport);
    const ctx = context();

    await secrets.get(SECRET);
    await advance(301);

    const read = track(secrets.get(SECRET, ctx));
    await advance(2);
    expect(read.state.settled).toBe(false);
    expect(ctx.scheduled).toHaveLength(0);

    pending.resolve(ok(ETAG_2, 'rotated-token'));
    expect(await read.promise).toBe('rotated-token');
  });

  it('serves the held bundle as stale when a revalidation hangs for 5 seconds', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockImplementation(hung);
    const secrets = createSecrets(transport);
    const ctx = context();

    await secrets.get(SECRET);
    await advance(301);

    const read = track(secrets.get(SECRET, ctx));
    await advance(4.9);
    expect(read.state.settled).toBe(false);

    await advance(0.1);
    expect(read.state.settled).toBe(true);
    expect(await read.promise).toBe('ae-token');
    expect((await secrets.snapshot()).stale).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls[2][0]).toEqual({ ifNoneMatch: ETAG_1 });

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('keeps a reader with no bundle waiting for 25 seconds while STS hangs, then fails retryable', async () => {
    const transport = vi.fn<Transport>(hung);
    const secrets = createSecrets(transport);

    const read = track(secrets.get(SECRET));
    await advance(24.9);
    expect(read.state.settled).toBe(false);

    await advance(0.1);
    const error = await read.promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'unavailable', retryable: true });
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it('lets a first load that takes 10 seconds succeed', async () => {
    const slow = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport.mockReturnValueOnce(slow.promise).mockImplementation(hung);
    const secrets = createSecrets(transport);

    const read = track(secrets.get(SECRET));
    await advance(5);
    expect(read.state.settled).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);

    await advance(5);
    slow.resolve(ok(ETAG_1, 'slow-token'));
    expect(await read.promise).toBe('slow-token');
    expect(await secrets.get(SECRET)).toBe('slow-token');
  });

  it('keeps values when STS answers not_modified and takes its stale flag', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(notModified(ETAG_1, true));
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    const snapshot = await secrets.snapshot();
    expect(snapshot.etag).toBe(ETAG_1);
    expect(snapshot.fetchedAt).toBe('2026-11-25T00:05:00.000Z');
    expect(snapshot.stale).toBe(true);
    expect(transport.mock.calls[1][0]).toEqual({ ifNoneMatch: ETAG_1 });
  });

  it('refuses a not_modified for an ETag it did not send', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(notModified(ETAG_2));
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect((await secrets.snapshot()).stale).toBe(true);
  });

  it('serves the last good bundle while STS is unavailable, then fails after 24 hours', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValue(unavailable(30));
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect((await secrets.snapshot()).stale).toBe(true);

    await advance(24 * 60 * 60 - 301);
    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'unavailable', retryable: true });
  });

  it('keeps the held bundle when the identity provider is unavailable', async () => {
    const transport = vi.fn<Transport>();
    transport
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(unavailable(30, 'internal'))
      .mockResolvedValueOnce(ok(ETAG_2, 'recovered-token'));
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(301);
    expect(await secrets.get(SECRET)).toBe('ae-token');

    await advance(31);
    expect(await secrets.get(SECRET)).toBe('ae-token');
    await advance(0);
    expect(await secrets.get(SECRET)).toBe('recovered-token');
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('retries a cold start that the identity provider made unavailable', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(unavailable(30, 'internal')).mockResolvedValueOnce(ok());
    const secrets = createSecrets(transport);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toMatchObject({ reason: 'unavailable', retryable: true });

    await advance(29);
    expect(await secrets.get(SECRET).catch((err: unknown) => err)).toBe(error);
    expect(transport).toHaveBeenCalledTimes(1);

    await advance(2);
    expect(await secrets.get(SECRET)).toBe('ae-token');
  });

  it('honours retryAfterSeconds before calling STS again', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValue(unavailable(30));
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(301);
    await secrets.get(SECRET);
    expect(transport).toHaveBeenCalledTimes(2);

    await advance(10);
    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(2);

    await advance(21);
    await secrets.get(SECRET);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('throws non-retryable when STS denies and stops serving held values', async () => {
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValue(denied());
    const secrets = createSecrets(transport);

    await secrets.get(SECRET);
    await advance(301);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'denied', retryable: false });

    await advance(3600);
    await expect(secrets.get(SECRET)).rejects.toThrow(/denied/);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('treats an identity rejection as non-retryable on a cold start', async () => {
    const transport = vi.fn<Transport>(async () => denied('identity_rejected'));
    const secrets = createSecrets(transport);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'denied', retryable: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('separates a missing secret from a name the policy does not grant', async () => {
    const transport = vi.fn<Transport>(async () => ({
      status: 'ok',
      workload: 'o11y',
      environment: 'production',
      etag: ETAG_1,
      stale: false,
      fetchedAt: '2026-11-25T00:00:00.000Z',
      secrets: {},
      missing: [SECRET],
    }));
    const secrets = createSecrets(transport);

    const missing = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(SecretUnavailableError);
    expect(missing).toMatchObject({ reason: 'missing', retryable: false });

    const notGranted = await secrets.get('O11Y_SLACK_WEBHOOK_PAGE').catch((err: unknown) => err);
    expect(notGranted).toBeInstanceOf(SecretUnavailableError);
    expect(notGranted).toMatchObject({ reason: 'not_granted', retryable: false });
  });

  it('drops a late answer from an attempt that a newer success replaced', async () => {
    const late = Promise.withResolvers<BundleResult>();
    const lateConfirmation = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport
      .mockResolvedValueOnce(ok(ETAG_1, 'old-token'))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(ok(ETAG_2, 'new-token'))
      .mockReturnValueOnce(lateConfirmation.promise)
      .mockImplementation(hung);
    const secrets = createSecrets(transport);
    const ctx = context();

    await secrets.get(SECRET);
    await advance(241);
    expect(await secrets.get(SECRET, ctx)).toBe('old-token');

    await advance(69);
    expect(await secrets.get(SECRET, ctx)).toBe('old-token');
    await advance(0);
    expect(await secrets.get(SECRET)).toBe('new-token');
    expect(transport).toHaveBeenCalledTimes(3);

    late.resolve(ok(ETAG_3, 'late-token'));
    await ctx.scheduled[0];
    expect(await secrets.get(SECRET)).toBe('new-token');
    expect((await secrets.snapshot()).etag).toBe(ETAG_2);

    await advance(301);
    const read = track(secrets.get(SECRET, ctx));
    await advance(5);
    expect(await read.promise).toBe('new-token');
    expect(transport).toHaveBeenCalledTimes(5);
    lateConfirmation.resolve(denied());
    await advance(0);
    expect(await secrets.get(SECRET)).toBe('new-token');
  });

  it('reports a rejected transport as a retryable failure', async () => {
    const transport = vi.fn<Transport>(async () => {
      throw new Error('binding threw');
    });
    const secrets = createSecrets(transport);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'unavailable', retryable: true });
  });

  it('rejects a bundle that does not match the contract', async () => {
    const transport = vi.fn<Transport>(
      async () => ({ status: 'ok', workload: 'o11y' }) as BundleResult
    );
    const secrets = createSecrets(transport);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ retryable: true });
  });
});
