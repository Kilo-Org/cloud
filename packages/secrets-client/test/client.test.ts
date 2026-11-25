import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { describe, expect, it, vi } from 'vitest';
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

function notModified(etag = ETAG_2): BundleResult {
  return { status: 'not_modified', etag, stale: false, fetchedAt: '2026-11-25T00:05:00.000Z' };
}

function denied(
  reason: 'identity_rejected' | 'unknown_workload' = 'unknown_workload'
): BundleResult {
  return { status: 'denied', reason };
}

function unavailable(retryAfterSeconds = 30): BundleResult {
  return { status: 'unavailable', reason: 'manager_unreachable_no_copy', retryAfterSeconds };
}

type Transport = (request: BundleRequest) => Promise<BundleResult>;

function setup() {
  let now = 1_700_000_000_000;
  const scheduled: Promise<unknown>[] = [];
  return {
    clock: () => now,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        scheduled.push(promise);
      },
    },
    scheduled,
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

describe('createSecrets', () => {
  it('shares one bundle fetch between concurrent readers', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>(async () => ok());
    const secrets = createSecrets(transport, { clock: harness.clock });

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
    const harness = setup();
    const transport = vi.fn<Transport>(async () => ok());
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(239);
    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('revalidates in the background after 240 seconds with ifNoneMatch', async () => {
    const harness = setup();
    const pending = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockReturnValueOnce(pending.promise);
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(241);

    expect(await secrets.get(SECRET, harness.ctx)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][0]).toEqual({ ifNoneMatch: ETAG_1 });
    expect(harness.scheduled).toHaveLength(1);

    pending.resolve(ok(ETAG_2, 'rotated-token'));
    await harness.scheduled[0];

    expect(await secrets.get(SECRET)).toBe('rotated-token');
    expect((await secrets.snapshot()).etag).toBe(ETAG_2);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('awaits revalidation once the 300 second cache expires', async () => {
    const harness = setup();
    const pending = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockReturnValueOnce(pending.promise);
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(301);

    let settled = false;
    const read = secrets.get(SECRET, harness.ctx).then(value => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(harness.scheduled).toHaveLength(0);

    pending.resolve(ok(ETAG_2, 'rotated-token'));
    expect(await read).toBe('rotated-token');
  });

  it('keeps values when STS answers not_modified', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(notModified(ETAG_2));
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    const snapshot = await secrets.snapshot();
    expect(snapshot.etag).toBe(ETAG_2);
    expect(snapshot.fetchedAt).toBe('2026-11-25T00:05:00.000Z');
    expect(snapshot.stale).toBe(false);
    expect(transport.mock.calls[1][0]).toEqual({ ifNoneMatch: ETAG_1 });
  });

  it('serves the last good bundle while STS is unavailable, then fails after 24 hours', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValue(unavailable(30));
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect((await secrets.snapshot()).stale).toBe(true);

    harness.advance(24 * 60 * 60 - 301);
    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });

  it('honours retryAfterSeconds before calling STS again', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValue(unavailable(30));
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(301);
    await secrets.get(SECRET);
    expect(transport).toHaveBeenCalledTimes(2);

    harness.advance(10);
    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(transport).toHaveBeenCalledTimes(2);

    harness.advance(21);
    await secrets.get(SECRET);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('throws non-retryable when STS denies and stops serving held values', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>();
    transport.mockResolvedValueOnce(ok()).mockResolvedValue(denied());
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(301);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('denied');
    expect(error.retryable).toBe(false);

    await expect(secrets.get(SECRET)).rejects.toThrow(/denied/);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('treats an identity rejection as non-retryable on a cold start', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>(async () => denied('identity_rejected'));
    const secrets = createSecrets(transport, { clock: harness.clock });

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('denied');
    expect(error.retryable).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('separates a missing secret from a name the policy does not grant', async () => {
    const harness = setup();
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
    const secrets = createSecrets(transport, { clock: harness.clock });

    const missing = await secrets.get(SECRET).catch(err => err);
    expect(missing).toBeInstanceOf(SecretUnavailableError);
    expect(missing.reason).toBe('missing');
    expect(missing.retryable).toBe(false);

    const notGranted = await secrets.get('O11Y_SLACK_WEBHOOK_PAGE').catch(err => err);
    expect(notGranted).toBeInstanceOf(SecretUnavailableError);
    expect(notGranted.reason).toBe('not_granted');
    expect(notGranted.retryable).toBe(false);
  });

  it('drops a late result from an abandoned revalidation', async () => {
    const harness = setup();
    const late = Promise.withResolvers<BundleResult>();
    const transport = vi.fn<Transport>();
    transport
      .mockResolvedValueOnce(ok(ETAG_1, 'old-token'))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(ok(ETAG_2, 'new-token'));
    const secrets = createSecrets(transport, { clock: harness.clock });

    await secrets.get(SECRET);
    harness.advance(241);
    expect(await secrets.get(SECRET, harness.ctx)).toBe('old-token');
    expect(harness.scheduled).toHaveLength(1);

    harness.advance(69);
    expect(await secrets.get(SECRET, harness.ctx)).toBe('new-token');
    expect(transport).toHaveBeenCalledTimes(3);

    late.resolve(ok(ETAG_3, 'late-token'));
    await harness.scheduled[0];

    expect(await secrets.get(SECRET)).toBe('new-token');
    expect((await secrets.snapshot()).etag).toBe(ETAG_2);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('reports a rejected transport as a retryable failure', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>(async () => {
      throw new Error('binding threw');
    });
    const secrets = createSecrets(transport, { clock: harness.clock });

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });

  it('rejects a bundle that does not match the contract', async () => {
    const harness = setup();
    const transport = vi.fn<Transport>(
      async () => ({ status: 'ok', workload: 'o11y' }) as BundleResult
    );
    const secrets = createSecrets(transport, { clock: harness.clock });

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.retryable).toBe(true);
  });
});
