import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TELEMETRY_DESCRIPTION_KEY } from '@/lib/telemetry/error-sink';

import { hfGet, HfRequestError, isHfGone, isHfRestricted, retryHfQuery } from './hf-request';

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
vi.stubGlobal('fetch', fetchMock);

const URL_UNDER_TEST = 'https://huggingface.co/api/models/acme/Tiny-Chat-GGUF';

const control = () => new AbortController();

/** The rejection the stubbed `fetch` made `hfGet` produce. */
async function rejection(): Promise<Error> {
  try {
    await hfGet(URL_UNDER_TEST, control().signal);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the request to reject');
}

/** The rejection of an answer with an error status. */
function rejectionOfStatus(status: number): Promise<Error> {
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'no' }, { status }));
  return rejection();
}

/** The telemetry the app-wide query reporter reads off a rejection. */
function declarationOf(error: Error): Record<string, unknown> {
  const declaration = Reflect.get(error, TELEMETRY_DESCRIPTION_KEY) as
    | Record<string, unknown>
    | undefined;
  expect(declaration).toBeDefined();
  return declaration ?? {};
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('hfGet', () => {
  it('returns the parsed body and the next-page link of an answer', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: 'acme/Tiny-Chat-GGUF' }, { headers: { link: '<next>; rel="next"' } })
    );

    const response = await hfGet(URL_UNDER_TEST, control().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      URL_UNDER_TEST,
      expect.objectContaining({
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(response.body).toEqual({ id: 'acme/Tiny-Chat-GGUF' });
    expect(response.link).toBe('<next>; rel="next"');
  });

  it('classifies a 404 as a repository that is gone, and never retries it', async () => {
    const error = await rejectionOfStatus(404);

    expect(error).toBeInstanceOf(HfRequestError);
    expect((error as HfRequestError).status).toBe(404);
    expect(isHfGone(error)).toBe(true);
    expect(isHfRestricted(error)).toBe(false);
    expect(retryHfQuery(0, error)).toBe(false);
  });

  it.each([401, 403])(
    'classifies a %i as a repository this app may not read, and never retries it',
    async status => {
      const error = await rejectionOfStatus(status);

      expect(error).toBeInstanceOf(HfRequestError);
      expect((error as HfRequestError).status).toBe(status);
      expect(isHfGone(error)).toBe(false);
      expect(isHfRestricted(error)).toBe(true);
      expect(retryHfQuery(0, error)).toBe(false);
    }
  );

  it.each([429, 500, 503])('retries a %i answer twice, then stops', async status => {
    const error = await rejectionOfStatus(status);

    expect(isHfGone(error)).toBe(false);
    expect(isHfRestricted(error)).toBe(false);
    expect(retryHfQuery(0, error)).toBe(true);
    expect(retryHfQuery(1, error)).toBe(true);
    expect(retryHfQuery(2, error)).toBe(false);
  });

  it('does not retry an unexpected status', async () => {
    const error = await rejectionOfStatus(400);

    expect(error).toBeInstanceOf(HfRequestError);
    expect(isHfGone(error)).toBe(false);
    expect(isHfRestricted(error)).toBe(false);
    expect(retryHfQuery(0, error)).toBe(false);
  });

  it('retries a request that never got an answer, twice', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const error = await rejection();

    expect((error as HfRequestError).status).toBeUndefined();
    expect(retryHfQuery(0, error)).toBe(true);
    expect(retryHfQuery(1, error)).toBe(true);
    expect(retryHfQuery(2, error)).toBe(false);
  });

  it('hands a cancelled query back as it arrived, so nothing retries it', async () => {
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);

    await expect(hfGet(URL_UNDER_TEST, control().signal)).rejects.toBe(abort);
    expect(retryHfQuery(0, abort)).toBe(false);
  });

  it('does not retry an answer whose body breaks the wire contract', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const error = await rejection();

    expect(error).toBeInstanceOf(SyntaxError);
    expect(retryHfQuery(0, error)).toBe(false);
  });
});

describe('the telemetry the failure declares', () => {
  it('leaves the reporting to the network layer, under the status it answered', async () => {
    const error = await rejectionOfStatus(500);

    expect(declarationOf(error)).toMatchObject({
      level: 'warning',
      report: 'none',
      fingerprint: ['hf-catalog', 'http.500'],
      tags: { 'error.subsystem': 'hf-catalog', 'http.status': 500 },
    });
  });

  it('leaves a request that got no answer to the network layer too', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const error = await rejection();

    expect(declarationOf(error)).toMatchObject({
      level: 'warning',
      report: 'none',
      fingerprint: ['hf-catalog', 'transport'],
      tags: { 'error.subsystem': 'hf-catalog' },
    });
  });
});
