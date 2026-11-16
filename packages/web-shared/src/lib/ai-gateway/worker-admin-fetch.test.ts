import { beforeEach, describe, expect, test } from '@jest/globals';
import * as z from 'zod';
import { createWorkerAdminFetch } from './worker-admin-fetch';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const unconfiguredError = 'Worker is not configured';
const responseSchema = z.object({ ok: z.literal(true) });

function configuredFetch(workerUrl: string | undefined) {
  return createWorkerAdminFetch({ workerUrl, unconfiguredError });
}

describe('createWorkerAdminFetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  test('sends an admin request to an https worker endpoint', async () => {
    const fetchAdmin = configuredFetch('https://worker.example.com');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(mockFetch).toHaveBeenCalledWith('https://worker.example.com/admin/x', {
      method: 'GET',
      headers: { authorization: 'Bearer test-internal-secret' },
    });
  });

  test('sends an admin request to a loopback http worker endpoint', async () => {
    const fetchAdmin = configuredFetch('http://127.0.0.1:8799');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:8799/admin/x', {
      method: 'GET',
      headers: { authorization: 'Bearer test-internal-secret' },
    });
  });

  test.each(['http://worker.example.com', 'ftp://worker.example.com', undefined])(
    'keeps an endpoint outside the rule unconfigured',
    async workerUrl => {
      const fetchAdmin = configuredFetch(workerUrl);

      await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
        status: 500,
        body: { error: unconfiguredError },
      });

      expect(mockFetch).not.toHaveBeenCalled();
    }
  );
});
