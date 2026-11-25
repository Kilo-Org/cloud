import { STS_FETCHED_AT_HEADER, STS_STALE_HEADER } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError } from '../src/errors';
import { createHttpSecrets } from '../src/http';

const ETAG_1 = '"0123456789abcdef"';
const ETAG_2 = '"fedcba9876543210"';
const STS_URL = 'https://sts.kiloapps.io';
const SECRET = 'O11Y_CF_AE_API_TOKEN';
const NOW = Date.parse('2026-11-25T01:00:00.000Z');

function ok(value = 'ae-token', etag = ETAG_1): unknown {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notModified(etag: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 304, headers: { ETag: etag, ...extra } });
}

function setup(responses: Response[], getIdentityToken: () => string | Promise<string>) {
  const fetchFn = vi.fn<typeof fetch>();
  for (const response of responses) fetchFn.mockResolvedValueOnce(response);
  return {
    fetchFn,
    secrets: createHttpSecrets({ stsUrl: `${STS_URL}/`, getIdentityToken, fetch: fetchFn }),
  };
}

function withToken(responses: Response[]) {
  return setup(responses, () => 'identity-token');
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHttpSecrets', () => {
  it('posts the request with the bearer token and returns the bundle value', async () => {
    const { fetchFn, secrets } = withToken([json(ok())]);

    expect(await secrets.get(SECRET)).toBe('ae-token');

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${STS_URL}/v1/bundle`);
    expect(init?.method).toBe('POST');
    expect(headersOf(init).get('Authorization')).toBe('Bearer identity-token');
    expect(init?.body).toBe('{}');
  });

  it('sends If-None-Match and reads the stale flag and fetch time of a 304', async () => {
    const { fetchFn, secrets } = withToken([
      json(ok()),
      notModified(ETAG_1, {
        [STS_STALE_HEADER]: 'true',
        [STS_FETCHED_AT_HEADER]: '2026-11-25T00:04:00.000Z',
      }),
    ]);

    await secrets.get(SECRET);
    await advance(301);
    expect(await secrets.get(SECRET)).toBe('ae-token');

    const init = fetchFn.mock.calls[1][1];
    expect(headersOf(init).get('If-None-Match')).toBe(ETAG_1);
    expect(init?.body).toBe(JSON.stringify({ ifNoneMatch: ETAG_1 }));
    expect(await secrets.snapshot()).toEqual({
      stale: true,
      fetchedAt: '2026-11-25T00:04:00.000Z',
      etag: ETAG_1,
    });
  });

  it('treats a 304 without the stale header as fresh', async () => {
    const { secrets } = withToken([json(ok()), notModified(ETAG_1)]);

    await secrets.get(SECRET);
    await advance(301);
    await secrets.get(SECRET);

    expect(await secrets.snapshot()).toEqual({
      stale: false,
      fetchedAt: new Date(NOW + 301_000).toISOString(),
      etag: ETAG_1,
    });
  });

  it('keeps the held bundle when a 304 carries an invalid stale header', async () => {
    const { secrets } = withToken([json(ok()), notModified(ETAG_1, { [STS_STALE_HEADER]: 'yes' })]);

    await secrets.get(SECRET);
    await advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(await secrets.snapshot()).toMatchObject({
      stale: true,
      fetchedAt: '2026-11-25T00:00:00.000Z',
    });
  });

  it('maps 401 identity_rejected to a non-retryable failure', async () => {
    const { secrets } = withToken([json({ status: 'denied', reason: 'identity_rejected' }, 401)]);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'denied', retryable: false });
  });

  it('maps 403 to a non-retryable failure', async () => {
    const { secrets } = withToken([json({ status: 'denied', reason: 'unknown_workload' }, 403)]);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'denied', retryable: false });
  });

  it('maps 503 to a retryable failure that honours retryAfterSeconds', async () => {
    const { fetchFn, secrets } = withToken([
      json({ status: 'unavailable', reason: 'internal', retryAfterSeconds: 30 }, 503),
      json(ok('recovered-token')),
    ]);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'unavailable', retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await advance(29);
    expect(await secrets.get(SECRET).catch((err: unknown) => err)).toBeInstanceOf(
      SecretUnavailableError
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await advance(2);
    expect(await secrets.get(SECRET)).toBe('recovered-token');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps the held bundle when STS reports its identity provider unavailable', async () => {
    const { secrets } = withToken([
      json(ok()),
      json({ status: 'unavailable', reason: 'internal', retryAfterSeconds: 30 }, 503),
    ]);

    await secrets.get(SECRET);
    await advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect((await secrets.snapshot()).stale).toBe(true);
  });

  it('keeps the held bundle when the token provider fails', async () => {
    const getIdentityToken = vi.fn<() => Promise<string>>();
    getIdentityToken
      .mockResolvedValueOnce('identity-token')
      .mockRejectedValueOnce(new Error('token endpoint down'));
    const { fetchFn, secrets } = setup([json(ok())], getIdentityToken);

    await secrets.get(SECRET);
    await advance(301);

    expect(await secrets.get(SECRET)).toBe('ae-token');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty identity token as retryable', async () => {
    const { fetchFn, secrets } = setup([], () => '');

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ retryable: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a body that does not match the contract', async () => {
    const { secrets } = withToken([json({ status: 'ok', workload: 'o11y' })]);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('rejects a status that does not match its body', async () => {
    const { secrets } = withToken([json(ok(), 500)]);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('rejects a 304 to a request that sent no ETag', async () => {
    const { secrets } = withToken([new Response(null, { status: 304 })]);

    const error = await secrets.get(SECRET).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('revalidates with the ETag of the latest bundle', async () => {
    const { fetchFn, secrets } = withToken([
      json(ok()),
      json(ok('rotated-token', ETAG_2)),
      notModified(ETAG_2),
    ]);

    await secrets.get(SECRET);
    await advance(301);
    expect(await secrets.get(SECRET)).toBe('rotated-token');
    await advance(301);
    expect(await secrets.get(SECRET)).toBe('rotated-token');

    expect(headersOf(fetchFn.mock.calls[2][1]).get('If-None-Match')).toBe(ETAG_2);
  });
});
