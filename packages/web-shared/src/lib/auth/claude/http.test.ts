import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fetchClaudeWithRetry } from './http';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Claude refusal retries', () => {
  it('retries an explicit overload and creates fresh authorization each time', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    let assertion = 0;
    const response = await fetchClaudeWithRetry(
      'https://example.test',
      async () => ({ headers: { authorization: `assertion-${++assertion}` } }),
      status => status === 503
    );
    expect(await response.text()).toBe('ok');
    expect(fetchMock.mock.calls.map(([, options]) => options?.headers)).toEqual([
      { authorization: 'assertion-1' },
      { authorization: 'assertion-2' },
    ]);
  });

  it.each([402, 403])('does not retry a customer billing refusal (%s)', async status => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('refused', { status }));
    expect(
      (
        await fetchClaudeWithRetry(
          'https://example.test',
          async () => ({}),
          code => code === 503
        )
      ).status
    ).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a long Retry-After rather than retrying before it elapsed', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('busy', { status: 503, headers: { 'retry-after': '60' } }));
    expect(
      (
        await fetchClaudeWithRetry(
          'https://example.test',
          async () => ({}),
          code => code === 503
        )
      ).status
    ).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never replays inference after an ambiguous network failure', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connection lost'));
    await expect(
      fetchClaudeWithRetry(
        'https://example.test',
        async () => ({}),
        code => code === 503
      )
    ).rejects.toThrow('connection lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
