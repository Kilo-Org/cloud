import { describe, expect, it, jest } from '@jest/globals';
import type { ExaUsageRecord } from '@kilocode/usage-contracts';
import {
  EXA_USAGE_FALLBACK_TIMEOUT_MS,
  publishExaUsageFallback,
  type ExaUsageFallbackConfig,
} from './exa-usage-fallback';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({}));

const record: ExaUsageRecord = {
  id: '6a1c2e3f-4b5d-4e6f-8a7b-9c0d1e2f3a4b',
  occurredAt: '2026-11-09T10:11:12.945Z',
  userId: 'oauth/github:synthetic',
  organizationId: null,
  path: '/search',
  costMicrodollars: 7000,
  chargedToBalance: true,
  freeAllowanceMicrodollars: 10_000_000,
};

const INGEST_URL = 'https://ingest.example.test/exa-usage';
const enabled: ExaUsageFallbackConfig = {
  enabled: true,
  url: INGEST_URL,
  secret: 'synthetic-exa-publisher',
};

function fetchReturning(response: Response | Error) {
  return jest.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe('publishExaUsageFallback', () => {
  it('does nothing while the flag is off, even when fully configured', async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 202 }));
    await expect(
      publishExaUsageFallback(record, { ...enabled, enabled: false }, fetchImpl)
    ).resolves.toEqual({ fallback: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['no URL', { url: undefined }],
    ['no secret', { secret: undefined }],
    ['a relative URL', { url: '/exa-usage' }],
    ['a scheme-less URL', { url: 'localhost:8787/exa-usage' }],
    ['a non-http URL', { url: 'ftp://ingest.example.test/exa-usage' }],
  ])('skips before any I/O with %s', async (_label, override) => {
    const fetchImpl = fetchReturning(new Response(null, { status: 202 }));
    await expect(
      publishExaUsageFallback(record, { ...enabled, ...override }, fetchImpl)
    ).resolves.toEqual({ fallback: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('publishes the identical record once with its own bearer secret and a short bound', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetchImpl = fetchReturning(new Response(null, { status: 202 }));
    await expect(publishExaUsageFallback(record, enabled, fetchImpl)).resolves.toEqual({
      fallback: 'published',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(INGEST_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enabled.secret}`,
      },
      body: JSON.stringify(record),
      signal: expect.any(AbortSignal),
    });
    expect(timeout.mock.calls).toEqual([[EXA_USAGE_FALLBACK_TIMEOUT_MS]]);
    timeout.mockRestore();
  });

  it('treats HTTP 400 as a terminal rejection', async () => {
    const fetchImpl = fetchReturning(
      Response.json({ error: 'Invalid usage payload' }, { status: 400 })
    );
    await expect(publishExaUsageFallback(record, enabled, fetchImpl)).resolves.toEqual({
      fallback: 'rejected',
      fallback_status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 413, 503, 302])('reports HTTP %s without retrying', async status => {
    const fetchImpl = fetchReturning(new Response(null, { status }));
    await expect(publishExaUsageFallback(record, enabled, fetchImpl)).resolves.toEqual({
      fallback: 'http_error',
      fallback_status: status,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a transport failure without retrying', async () => {
    const fetchImpl = fetchReturning(new Error(`connect failed ${enabled.secret}`));
    await expect(publishExaUsageFallback(record, enabled, fetchImpl)).resolves.toEqual({
      fallback: 'request_failed',
      fallback_error: 'Error',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout when the bound elapses', async () => {
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    const fetchImpl = jest.fn<typeof fetch>(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return new Response(null, { status: 202 });
    });
    await expect(publishExaUsageFallback(record, enabled, fetchImpl)).resolves.toEqual({
      fallback: 'timeout',
      fallback_error: 'TimeoutError',
    });
    timeout.mockRestore();
  });

  it('does not publish a record that fails the wire contract', async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 202 }));
    await expect(
      publishExaUsageFallback({ ...record, organizationId: 'not-a-uuid' }, enabled, fetchImpl)
    ).resolves.toEqual({ fallback: 'invalid_record' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
