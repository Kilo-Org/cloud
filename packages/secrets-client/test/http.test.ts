import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError } from '../src/errors';
import { createHttpSecrets } from '../src/http';

const ETAG_1 = '"0123456789abcdef"';
const ETAG_2 = '"fedcba9876543210"';
const STS_URL = 'https://sts.kiloapps.io';
const SECRET = 'O11Y_CF_AE_API_TOKEN';

function ok(value = 'ae-token'): unknown {
  return {
    status: 'ok',
    workload: 'o11y',
    environment: 'production',
    etag: ETAG_1,
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

function setup(responses: Response[]) {
  let now = 1_700_000_000_000;
  const fetchFn = vi.fn<typeof fetch>();
  for (const response of responses) fetchFn.mockResolvedValueOnce(response);
  return {
    fetchFn,
    secrets: createHttpSecrets({
      stsUrl: `${STS_URL}/`,
      getIdentityToken: () => 'identity-token',
      fetch: fetchFn,
      clock: () => now,
    }),
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('createHttpSecrets', () => {
  it('posts the request with the bearer token and returns the bundle value', async () => {
    const { fetchFn, secrets } = setup([json(ok())]);

    expect(await secrets.get(SECRET)).toBe('ae-token');

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${STS_URL}/v1/bundle`);
    expect(init?.method).toBe('POST');
    expect(headersOf(init).get('Authorization')).toBe('Bearer identity-token');
    expect(init?.body).toBe('{}');
  });

  it('sends If-None-Match and keeps values on 304', async () => {
    const { fetchFn, secrets, advance } = setup([
      json(ok()),
      new Response(null, { status: 304, headers: { ETag: ETAG_2 } }),
    ]);

    await secrets.get(SECRET);
    advance(301);
    expect(await secrets.get(SECRET)).toBe('ae-token');

    expect(headersOf(fetchFn.mock.calls[1][1]).get('If-None-Match')).toBe(ETAG_1);
    expect((await secrets.snapshot()).etag).toBe(ETAG_2);
  });

  it('maps 401 identity_rejected to a non-retryable failure', async () => {
    const { secrets } = setup([json({ status: 'denied', reason: 'identity_rejected' }, 401)]);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('denied');
    expect(error.retryable).toBe(false);
  });

  it('maps 403 to a non-retryable failure', async () => {
    const { secrets } = setup([json({ status: 'denied', reason: 'unknown_workload' }, 403)]);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('denied');
    expect(error.retryable).toBe(false);
  });

  it('maps 503 to a retryable failure that honours retryAfterSeconds', async () => {
    const { fetchFn, secrets, advance } = setup([
      json(
        { status: 'unavailable', reason: 'manager_unreachable_no_copy', retryAfterSeconds: 30 },
        503
      ),
      json(ok('recovered-token')),
    ]);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    advance(29);
    expect(await secrets.get(SECRET).catch(err => err)).toBeInstanceOf(SecretUnavailableError);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    advance(2);
    expect(await secrets.get(SECRET)).toBe('recovered-token');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects a body that does not match the contract', async () => {
    const { secrets } = setup([json({ status: 'ok', workload: 'o11y' })]);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.retryable).toBe(true);
  });

  it('rejects a status that does not match its body', async () => {
    const { secrets } = setup([json(ok(), 500)]);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.retryable).toBe(true);
  });

  it('rejects a 304 that carries no ETag', async () => {
    const { secrets } = setup([new Response(null, { status: 304 })]);

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.retryable).toBe(true);
  });

  it('rejects an empty identity token as retryable', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const secrets = createHttpSecrets({
      stsUrl: STS_URL,
      getIdentityToken: () => '',
      fetch: fetchFn,
    });

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.retryable).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the response ETag header for the next revalidation', async () => {
    const { fetchFn, secrets, advance } = setup([
      json(ok()),
      new Response(null, { status: 304, headers: { ETag: ETAG_2 } }),
      new Response(null, { status: 304, headers: { ETag: ETAG_2 } }),
    ]);

    await secrets.get(SECRET);
    advance(301);
    await secrets.get(SECRET);
    advance(301);
    await secrets.get(SECRET);

    expect(headersOf(fetchFn.mock.calls[2][1]).get('If-None-Match')).toBe(ETAG_2);
  });
});
