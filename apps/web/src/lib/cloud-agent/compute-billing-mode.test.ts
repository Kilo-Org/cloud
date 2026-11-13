/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the fakes must be installed before the module under test loads */

const mockFetchWithinBudget = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: () => 'https://cloud-agent.test',
}));
jest.mock('@/lib/bounded-service-fetch', () => ({
  fetchWithinBudget: (...args: unknown[]) => mockFetchWithinBudget(...args),
}));

import { readPersonalContainersBillingMode } from './compute-billing-mode';

describe('readPersonalContainersBillingMode', () => {
  it.each(['shadow', 'paid'] as const)(
    'reads the user decision for the instance: %s',
    async mode => {
      mockFetchWithinBudget.mockResolvedValueOnce(Response.json({ billingMode: mode }));
      await expect(readPersonalContainersBillingMode('oauth/user', 'standard-3')).resolves.toBe(
        mode
      );
      expect(mockFetchWithinBudget).toHaveBeenLastCalledWith(
        'https://cloud-agent.test/internal/containers/billing/user/oauth%2Fuser/standard-3',
        { headers: { 'x-internal-api-key': 'test-internal-secret' }, cache: 'no-store' }
      );
    }
  );

  it.each([
    ['a failed response', new Response('unavailable', { status: 503 })],
    ['an unknown billing mode', Response.json({ billingMode: 'free' })],
  ])('rejects %s', async (_case, response) => {
    mockFetchWithinBudget.mockResolvedValueOnce(response);
    await expect(readPersonalContainersBillingMode('user-1', 'standard-4')).rejects.toThrow();
  });
});
