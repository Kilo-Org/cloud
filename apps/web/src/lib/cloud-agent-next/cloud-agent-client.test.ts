import { beforeAll, describe, expect, it, jest } from '@jest/globals';

import type * as ClientModule from './cloud-agent-client';

const createTRPCClient = jest.fn();
const httpLink = jest.fn();

jest.mock('@trpc/client', () => ({
  createTRPCClient,
  httpLink,
  TRPCClientError: class TRPCClientError extends Error {},
}));

jest.mock('@/lib/dotenvx', () => ({ getEnvVariable: jest.fn(() => 'https://agent.example.com') }));
jest.mock('@/lib/config.server', () => ({ INTERNAL_API_SECRET: 'internal-secret' }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

let clientModule: ClientModule;

beforeAll(async () => {
  clientModule = await import('./cloud-agent-client');
});

describe('CloudAgentNextClient', () => {
  it('uses ordinary authentication headers without a balance bypass header', () => {
    httpLink.mockReturnValue({});
    createTRPCClient.mockReturnValue({});

    new clientModule.CloudAgentNextClient('user-token');

    const options = httpLink.mock.calls[0]?.[0] as { headers: () => Record<string, string> };
    expect(options.headers()).toEqual({
      Authorization: 'Bearer user-token',
      'x-internal-api-key': 'internal-secret',
    });
    expect(options.headers()).not.toHaveProperty('x-skip-balance-check');
  });

  it('normalizes an insufficient-credit error for web router procedures', () => {
    try {
      clientModule.rethrowAsPaymentRequired(new clientModule.InsufficientCreditsError());
    } catch (error) {
      expect(error).toMatchObject({
        code: 'PAYMENT_REQUIRED',
        message: 'Insufficient credits: a positive credit balance is required',
      });
      return;
    }
    throw new Error('Expected a PAYMENT_REQUIRED error');
  });
});
