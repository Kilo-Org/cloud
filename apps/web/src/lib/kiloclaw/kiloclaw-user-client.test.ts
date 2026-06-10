jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-test-secret',
  KILOCLAW_API_URL: 'https://claw.test',
}));

import { KiloClawApiError } from './kiloclaw-internal-client';
import { KiloClawUserClient } from './kiloclaw-user-client';

describe('KiloClawUserClient restart failures', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves the sanitized Worker error body on KiloClawApiError', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{"success":false,"error":"No machine exists","unexpected":"do not preserve"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    );

    const client = new KiloClawUserClient('user-token');
    let thrown: unknown;

    try {
      await client.restartMachine(undefined, { userId: 'user-1' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(KiloClawApiError);
    if (!(thrown instanceof KiloClawApiError)) throw thrown;
    expect(thrown.statusCode).toBe(404);
    expect(JSON.parse(thrown.responseBody)).toEqual({
      success: false,
      error: 'No machine exists',
    });
  });
});
